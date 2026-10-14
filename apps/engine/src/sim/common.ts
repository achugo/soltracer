import type { ErrorResponse } from "@soltracer/shared/errors";
import type { SimulationResult, TxError } from "@soltracer/shared/simulation";
import { getBase64Encoder, type Address } from "@solana/kit";
import type { IdlCacheEntry, SandboxCaches } from "../cache/types.ts";
import { builtinCustomError, SYSTEM_PROGRAM } from "../decode/builtin-errors.ts";
import { anchorIdlAddress } from "../decode/idl-address.ts";
import { normalizeIdl, type NormalizedIdl } from "../decode/idl-full.ts";
import { idlErrorsFromJson, IdlParseError, inflateIdl } from "../decode/idl.ts";
import { describeFailure, locateFailure } from "../decode/program-error.ts";
import { parseMintDecimals, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../decode/token-account.ts";
import type { AccountState, SolChange, TokenChange } from "../diff/balances.ts";
import { getMultipleAccountsBatched } from "../rpc/accounts.ts";
import type { RpcSession } from "../rpc/client.ts";
import { COMPUTE_BUDGET_PROGRAM } from "../tx/compute-budget.ts";
import { LookupTableError, parseLookupTable } from "../tx/lookup-tables.ts";

/** Solana's fixed base fee per signature, used when getFeeForMessage cannot price the message. */
export const LAMPORTS_PER_SIGNATURE = 5000n;
const NO_IDL_PROGRAMS = new Set<Address>([SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, COMPUTE_BUDGET_PROGRAM as Address]);

/** Builtins, precompiles and native SPL programs: none publishes an Anchor IDL, so none is looked up. */
const NON_ANCHOR_PROGRAMS = new Set<string>([
  ...NO_IDL_PROGRAMS,
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
  "Vote111111111111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "Config1111111111111111111111111111111111111",
  "AddressLookupTab1e1111111111111111111111111",
  "BPFLoader1111111111111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "LoaderV411111111111111111111111111111111111",
  "Ed25519SigVerify111111111111111111111111111",
  "KeccakSecp256k11111111111111111111111111111",
  "Secp256r1SigVerify1111111111111111111111111",
]);

/** How a run gets IDLs to decode with: read uncached ones (one batched call), or use only what's cached. */
export type IdlMode = "fetch" | "cached";

export type SimulateOutcome = { ok: true; result: SimulationResult } | { ok: false; status: number; error: ErrorResponse };

export interface SimulatorLog {
  info(obj: Record<string, unknown>, msg: string): void;
}

export const base64 = getBase64Encoder();

export function toState(account: { lamports: bigint; owner: Address; data: Uint8Array } | null): AccountState | null {
  return account ? { lamports: account.lamports, owner: account.owner, data: account.data } : null;
}

/**
 * A failed transaction changes no state except charging the fee payer, and simulateTransaction
 * returns no accounts for it; model that rather than reading missing accounts as closed.
 */
export function feeOnlyPostState(
  writable: readonly Address[],
  pre: readonly (AccountState | null)[],
  feePayer: Address | undefined,
  fee: bigint,
): (AccountState | null)[] {
  return pre.map((state, i) =>
    state && writable[i] === feePayer ? { ...state, lamports: state.lamports > fee ? state.lamports - fee : 0n } : state,
  );
}

/** Loads the lookup tables a v0 transaction needs, from cache when the cached copy is long enough. */
export async function loadTables(
  session: RpcSession,
  caches: SandboxCaches,
  lookups: readonly { table: Address; writableIndexes: number[]; readonlyIndexes: number[] }[],
): Promise<Map<Address, Address[]>> {
  if (lookups.length === 0) return new Map();
  const needed = new Map(lookups.map((l) => [l.table, Math.max(-1, ...l.writableIndexes, ...l.readonlyIndexes)]));
  const tables = await caches.lookupTables.getMany([...needed.keys()]);
  const missing = [...needed].filter(([table, maxIndex]) => (tables.get(table)?.length ?? 0) <= maxIndex).map(([t]) => t);
  if (missing.length === 0) return tables;

  const { slot, accounts } = await getMultipleAccountsBatched(session.rpc, missing);
  const fresh = missing.map((address, i) => {
    const account = accounts[i];
    if (!account) throw new LookupTableError(`Lookup table ${address} does not exist on-chain`);
    return { address, addresses: parseLookupTable(account.data), slot };
  });
  await caches.lookupTables.putMany(fresh);
  for (const t of fresh) tables.set(t.address, t.addresses);
  return tables;
}

/** Decimals for each mint, from cache or one batched read. */
export async function loadDecimals(session: RpcSession, caches: SandboxCaches, mints: readonly Address[]) {
  const known = await caches.mints.getMany(mints);
  const missing = mints.filter((m) => !known.has(m));
  if (missing.length > 0) {
    const { accounts } = await getMultipleAccountsBatched(session.rpc, missing);
    const fresh = new Map<Address, { decimals: number; program: "token" | "token-2022" }>();
    missing.forEach((mint, i) => {
      const account = accounts[i];
      const decimals = account ? parseMintDecimals(account.owner, account.data) : null;
      if (account && decimals !== null) {
        fresh.set(mint, { decimals, program: account.owner === TOKEN_2022_PROGRAM ? "token-2022" : "token" });
      }
    });
    await caches.mints.putMany(fresh);
    for (const [k, v] of fresh) known.set(k, v);
  }
  return known;
}

/** Largest normalized IDL kept for decoding (as JSON text); larger ones keep only their errors. */
export const MAX_STORED_IDL_CHARS = 1024 * 1024;

/** A program's Anchor IDL, from cache or one account read (1 credit). */
export async function loadIdl(session: RpcSession, caches: SandboxCaches, program: Address): Promise<IdlCacheEntry> {
  const cached = await caches.idls.get(program);
  if (cached) return cached;
  const account = await session.rpc.getAccountInfo(await anchorIdlAddress(program), { encoding: "base64" }).send();
  // The IDL account is created by the program and owned by it; anything else isn't its IDL.
  const value = account.value?.owner === program ? account.value : null;
  const entry = idlEntryFrom(value ? new Uint8Array(base64.encode(value.data[0])) : null);
  await caches.idls.put(program, entry);
  return entry;
}

/** A cache entry from an IDL account's data (null: no account). Unreadable IDLs count as absent. */
function idlEntryFrom(data: Uint8Array | null): IdlCacheEntry {
  if (!data) return { found: false };
  try {
    const json = inflateIdl(data);
    return { found: true, errors: idlErrorsFromJson(json), idl: decodingIdl(json) };
  } catch (err) {
    if (!(err instanceof IdlParseError)) throw err;
    return { found: false };
  }
}

/**
 * IDLs to decode a run's instructions and accounts with, for the programs it touched. In "fetch"
 * mode the uncached ones are read in one batched call (1 credit) and cached, absent or not.
 */
export async function loadDecodingIdls(
  session: RpcSession,
  caches: SandboxCaches,
  programs: readonly string[],
  mode: IdlMode,
): Promise<Map<string, NormalizedIdl>> {
  const idls = new Map<string, NormalizedIdl>();
  const missing: Address[] = [];
  for (const program of new Set(programs)) {
    if (NON_ANCHOR_PROGRAMS.has(program)) continue;
    const cached = await caches.idls.get(program as Address);
    if (cached?.found && cached.idl) idls.set(program, cached.idl);
    else if (!cached) missing.push(program as Address);
  }
  if (mode === "cached" || missing.length === 0) return idls;
  const addresses = await Promise.all(missing.map((p) => anchorIdlAddress(p)));
  const { accounts } = await getMultipleAccountsBatched(session.rpc, addresses);
  for (const [i, program] of missing.entries()) {
    const account = accounts[i];
    const entry = idlEntryFrom(account?.owner === program ? account.data : null);
    await caches.idls.put(program, entry);
    if (entry.found && entry.idl) idls.set(program, entry.idl);
  }
  return idls;
}

/** The IDL's decoding half; null (errors only) when it isn't an IDL we decode or is too large to keep. */
function decodingIdl(json: unknown): NormalizedIdl | null {
  try {
    const idl = normalizeIdl(json);
    return JSON.stringify(idl).length <= MAX_STORED_IDL_CHARS ? idl : null;
  } catch (err) {
    if (err instanceof IdlParseError) return null;
    throw err;
  }
}

/** IDL error table for a program that raised a custom error, from cache or one account read. */
export async function loadIdlErrors(session: RpcSession, caches: SandboxCaches, program: Address) {
  const entry = await loadIdl(session, caches, program);
  return entry.found ? entry.errors : null;
}


/** Status of a run: success, or the located and decoded error (fetching the IDL only if needed). */
export async function decodeStatus(
  err: unknown,
  logs: readonly string[],
  programs: readonly Address[],
  session: RpcSession,
  caches: SandboxCaches,
): Promise<SimulationResult["status"]> {
  if (!err) return { success: true };
  const site = locateFailure(err, logs, programs);
  const failing = site.failingProgramId;
  const needsIdl =
    site.customCode !== null &&
    failing !== null &&
    !NO_IDL_PROGRAMS.has(failing) &&
    builtinCustomError(failing, site.customCode, false) === null;
  const idlErrors = needsIdl && failing ? await loadIdlErrors(session, caches, failing) : null;
  const error: TxError = describeFailure(err, site, idlErrors && failing ? { program: failing, errors: idlErrors } : null);
  return { success: false, error };
}

/** Whether an RPC-shaped error was raised while executing (so the fee was charged). */
export function feeWasCharged(err: unknown): boolean {
  return typeof err === "object" && err !== null && "InstructionError" in err;
}

/** Balance changes in the shared contract's string form; tokens without known decimals are left out. */
export function formatBalances(
  changes: { sol: SolChange[]; tokens: TokenChange[] },
  decimals: ReadonlyMap<Address, { decimals: number }>,
): SimulationResult["balances"] {
  return {
    sol: changes.sol.map((c) => ({ address: c.address, pre: c.pre.toString(), post: c.post.toString(), delta: c.delta.toString() })),
    tokens: changes.tokens.flatMap((c) => {
      const info = decimals.get(c.mint);
      if (!info) return [];
      return [{
        account: c.account,
        owner: c.owner,
        mint: c.mint,
        program: c.program,
        decimals: info.decimals,
        pre: c.pre.toString(),
        post: c.post.toString(),
        delta: c.delta.toString(),
      }];
    }),
  };
}

