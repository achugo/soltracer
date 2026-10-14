import { getAddressDecoder, type Address } from "@solana/kit";
import { getMultipleAccountsBatched, type AccountSnapshot } from "../../rpc/accounts.ts";
import type { RpcSession } from "../../rpc/client.ts";

export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
/** Older loaders keep the ELF in the program account itself. */
export const DIRECT_LOADERS = new Set<Address>([
  "BPFLoader2111111111111111111111111111111111" as Address,
  "BPFLoader1111111111111111111111111111111111" as Address,
]);
/** Builtins live in LiteSVM itself. */
export const NATIVE_LOADER = "NativeLoader1111111111111111111111111111111" as Address;
export const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111" as Address;

/** UpgradeableLoaderState::ProgramData header: tag(4) + slot(8) + Option<authority>(1 + 32). */
const PROGRAMDATA_HEADER = 45;
const TAG_PROGRAM = 2;
const TAG_PROGRAMDATA = 3;

export class LocalLoadError extends Error {
  override name = "LocalLoadError";
}

export interface ClockValues {
  slot: bigint;
  epochStartTimestamp: bigint;
  epoch: bigint;
  leaderScheduleEpoch: bigint;
  unixTimestamp: bigint;
}

export interface LoadedProgram {
  programId: Address;
  elf: Uint8Array;
  /** Last deployment slot (upgradeable) or 0 (older loaders). */
  deploySlot: bigint;
  /** Set for older loaders that need it named explicitly. */
  loader?: Address;
}

export interface LoadedState {
  /** Every requested account as it is on mainnet now; null if it does not exist. */
  accounts: Map<Address, AccountSnapshot | null>;
  programs: LoadedProgram[];
  clock: ClockValues;
}

/** Executables by programdata address, re-used until the program is upgraded; LRU by byte budget. */
export interface ProgramCache {
  get(programData: Address): { deploySlot: bigint; elf: Uint8Array } | undefined;
  put(programData: Address, entry: { deploySlot: bigint; elf: Uint8Array }): void;
}

export function createProgramCache(maxBytes = 256 * 1024 * 1024): ProgramCache {
  const entries = new Map<Address, { deploySlot: bigint; elf: Uint8Array }>();
  let bytes = 0;
  return {
    get(key) {
      const hit = entries.get(key);
      if (hit) {
        entries.delete(key); // move to most-recently-used
        entries.set(key, hit);
      }
      return hit;
    },
    put(key, entry) {
      const old = entries.get(key);
      if (old) bytes -= old.elf.length;
      entries.delete(key);
      entries.set(key, entry);
      bytes += entry.elf.length;
      for (const [k, v] of entries) {
        if (bytes <= maxBytes || k === key) break;
        entries.delete(k);
        bytes -= v.elf.length;
      }
    },
  };
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const addressDecoder = getAddressDecoder();

/** The Clock sysvar: slot, epoch_start_timestamp, epoch, leader_schedule_epoch, unix_timestamp. */
export function parseClock(data: Uint8Array): ClockValues {
  if (data.length < 40) throw new LocalLoadError("Clock sysvar data is too short");
  const v = view(data);
  return {
    slot: v.getBigUint64(0, true),
    epochStartTimestamp: v.getBigInt64(8, true),
    epoch: v.getBigUint64(16, true),
    leaderScheduleEpoch: v.getBigUint64(24, true),
    unixTimestamp: v.getBigInt64(32, true),
  };
}

function programDataAddress(program: AccountSnapshot): Address {
  if (program.data.length < 36 || view(program.data).getUint32(0, true) !== TAG_PROGRAM) {
    throw new LocalLoadError(`Program ${program.address} has an unexpected upgradeable-loader layout`);
  }
  return addressDecoder.decode(program.data.subarray(4, 36));
}

function deploySlotOf(programData: Uint8Array): bigint {
  if (programData.length < PROGRAMDATA_HEADER || view(programData).getUint32(0, true) !== TAG_PROGRAMDATA) {
    throw new LocalLoadError("Programdata account has an unexpected layout");
  }
  return view(programData).getBigUint64(4, true);
}

/**
 * Mainnet state for a local run: every account the transaction touches plus the Clock in one batch,
 * then the executables of the programs among them (cached by programdata address and deploy slot).
 */
export async function loadState(keys: readonly Address[], session: RpcSession, cache: ProgramCache): Promise<LoadedState> {
  const wanted = [...new Set([...keys, CLOCK_SYSVAR])];
  const { slot, accounts: snapshots } = await getMultipleAccountsBatched(session.rpc, wanted);
  // Later reads must not be older than this snapshot.
  const minContextSlot = slot ?? undefined;
  const accounts = new Map<Address, AccountSnapshot | null>(wanted.map((k, i) => [k, snapshots[i] ?? null]));

  const clockAccount = accounts.get(CLOCK_SYSVAR);
  if (!clockAccount) throw new LocalLoadError("Could not read the Clock sysvar");
  const clock = parseClock(clockAccount.data);

  const programs: LoadedProgram[] = [];
  const upgradeable = new Map<Address, Address>(); // programdata -> program id
  for (const account of accounts.values()) {
    if (!account?.executable || account.owner === NATIVE_LOADER) continue;
    if (account.owner === UPGRADEABLE_LOADER) upgradeable.set(programDataAddress(account), account.address);
    else if (DIRECT_LOADERS.has(account.owner)) {
      programs.push({ programId: account.address, elf: account.data, deploySlot: 0n, loader: account.owner });
    } else {
      // e.g. LoaderV4: running without it would look like the user's transaction failing.
      throw new LocalLoadError(`Program ${account.address} uses an unsupported loader (${account.owner})`);
    }
  }

  // Collected locally so a cache eviction during this load can't drop a program this run needs.
  const resolved = new Map<Address, { deploySlot: bigint; elf: Uint8Array }>();

  // Cached programs: confirm they were not upgraded by reading just their headers.
  const cached = [...upgradeable.keys()].flatMap((pd) => {
    const hit = cache.get(pd);
    return hit ? [[pd, hit] as const] : [];
  });
  if (cached.length > 0) {
    const headers = await getMultipleAccountsBatched(
      session.rpc,
      cached.map(([pd]) => pd),
      { offset: 0, length: PROGRAMDATA_HEADER },
      minContextSlot,
    );
    cached.forEach(([pd, hit], i) => {
      const header = headers.accounts[i];
      if (header && deploySlotOf(header.data) === hit.deploySlot) resolved.set(pd, hit);
    });
  }
  const stale = [...upgradeable.keys()].filter((pd) => !resolved.has(pd));
  if (stale.length > 0) {
    const fresh = await getMultipleAccountsBatched(session.rpc, stale, undefined, minContextSlot);
    stale.forEach((pd, i) => {
      const account = fresh.accounts[i];
      if (!account) throw new LocalLoadError(`Program data ${pd} for ${upgradeable.get(pd)} is missing`);
      const entry = { deploySlot: deploySlotOf(account.data), elf: account.data.subarray(PROGRAMDATA_HEADER) };
      resolved.set(pd, entry);
      cache.put(pd, entry);
    });
  }
  for (const [pd, programId] of upgradeable) {
    const entry = resolved.get(pd);
    if (!entry) throw new LocalLoadError(`Program ${programId} could not be loaded`);
    programs.push({ programId, elf: entry.elf, deploySlot: entry.deploySlot });
  }

  return { accounts, programs, clock };
}
