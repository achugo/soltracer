import { address, getAddressEncoder, type Address, type RpcTransport } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { createRpcClient } from "../../../src/rpc/client.ts";
import { createRateLimiter } from "../../../src/rpc/rate-limiter.ts";
import {
  CLOCK_SYSVAR,
  createProgramCache,
  loadState,
  LocalLoadError,
  parseClock,
  UPGRADEABLE_LOADER,
} from "../../../src/sim/local/loader.ts";

const enc = getAddressEncoder();
const PROGRAM = address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const PROGRAMDATA = address("4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT");
const WALLET = address("SysvarRent111111111111111111111111111111111");
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};

function programAccount(): Uint8Array {
  return new Uint8Array([2, 0, 0, 0, ...enc.encode(PROGRAMDATA)]);
}
function programData(deploySlot: bigint, elf = ELF): Uint8Array {
  return new Uint8Array([3, 0, 0, 0, ...u64(deploySlot), 1, ...enc.encode(WALLET), ...elf]);
}
function clockData(slot: bigint): Uint8Array {
  return new Uint8Array([...u64(slot), ...u64(1_700_000_000n), ...u64(800n), ...u64(801n), ...u64(1_700_000_400n)]);
}

const ACCOUNTS: Record<string, { data: Uint8Array; owner: string; executable: boolean; lamports: number } | null> = {
  [WALLET]: { data: new Uint8Array(), owner: "11111111111111111111111111111111", executable: false, lamports: 5_000_000 },
  [PROGRAM]: { data: programAccount(), owner: UPGRADEABLE_LOADER, executable: true, lamports: 1 },
  [PROGRAMDATA]: { data: programData(100n), owner: UPGRADEABLE_LOADER, executable: false, lamports: 1 },
  [CLOCK_SYSVAR]: { data: clockData(345_000_000n), owner: "Sysvar1111111111111111111111111111111111111", executable: false, lamports: 1 },
};

/** Answers getMultipleAccounts from ACCOUNTS, honouring dataSlice; records each call. */
function fakeRpc(accounts = ACCOUNTS, opts: { nullOnSlice?: boolean } = {}) {
  const calls: { keys: string[]; slice: unknown }[] = [];
  const transport = (async ({ payload }: { payload: unknown }) => {
    const p = payload as { id: string; params: [string[], { dataSlice?: { offset: number; length: number } }] };
    const [keys, config] = p.params;
    calls.push({ keys, slice: config.dataSlice ?? null });
    const value = keys.map((k) => {
      const a = accounts[k];
      if (!a || (opts.nullOnSlice && config.dataSlice)) return null;
      const data = config.dataSlice ? a.data.subarray(config.dataSlice.offset, config.dataSlice.offset + config.dataSlice.length) : a.data;
      return { data: [b64(data), "base64"], owner: a.owner, executable: a.executable, lamports: a.lamports, rentEpoch: 0, space: a.data.length };
    });
    return { jsonrpc: "2.0", id: p.id, result: { context: { slot: 345_000_001 }, value } };
  }) as RpcTransport;
  const client = createRpcClient({ url: "https://fake.invalid", limiter: createRateLimiter({ limit: 100, windowMs: 1000 }), transport, log: { info: () => undefined, warn: () => undefined } });
  return { client, calls };
}

describe("parseClock", () => {
  it("reads the 40-byte Clock sysvar", () => {
    expect(parseClock(clockData(7n))).toEqual({
      slot: 7n,
      epochStartTimestamp: 1_700_000_000n,
      epoch: 800n,
      leaderScheduleEpoch: 801n,
      unixTimestamp: 1_700_000_400n,
    });
    expect(() => parseClock(new Uint8Array(10))).toThrow(LocalLoadError);
  });
});

describe("loadState", () => {
  it("loads accounts, the clock and upgradeable programs in two batched calls", async () => {
    const { client, calls } = fakeRpc();
    const session = client.session();
    const state = await loadState([WALLET, PROGRAM], session, createProgramCache());
    expect(calls.map((c) => c.keys)).toEqual([[WALLET, PROGRAM, CLOCK_SYSVAR], [PROGRAMDATA]]);
    expect(state.accounts.get(WALLET)?.lamports).toBe(5_000_000n);
    expect(state.programs).toEqual([{ programId: PROGRAM, elf: ELF, deploySlot: 100n }]);
    expect(state.clock.slot).toBe(345_000_000n);
    expect(session.credits()).toBe(2);
  });

  it("re-uses a cached program after checking only its 45-byte header", async () => {
    const cache = createProgramCache();
    await loadState([WALLET, PROGRAM], fakeRpc().client.session(), cache);
    const { client, calls } = fakeRpc();
    const state = await loadState([WALLET, PROGRAM], client.session(), cache);
    expect(calls[1]).toEqual({ keys: [PROGRAMDATA], slice: { offset: 0, length: 45 } });
    expect(calls).toHaveLength(2);
    expect(state.programs[0]?.elf).toEqual(ELF);
  });

  it("re-downloads a program that was upgraded since it was cached", async () => {
    const cache = createProgramCache();
    await loadState([PROGRAM], fakeRpc().client.session(), cache);
    const upgraded = { ...ACCOUNTS, [PROGRAMDATA]: { ...(ACCOUNTS[PROGRAMDATA] as NonNullable<(typeof ACCOUNTS)[string]>), data: programData(200n, new Uint8Array([9, 9])) } };
    const { client, calls } = fakeRpc(upgraded);
    const state = await loadState([PROGRAM], client.session(), cache);
    expect(calls).toHaveLength(3); // accounts, header check, full programdata
    expect(state.programs[0]).toEqual({ programId: PROGRAM, elf: new Uint8Array([9, 9]), deploySlot: 200n });
  });

  it("fails clearly when an invoked program's data is missing", async () => {
    const { client } = fakeRpc({ ...ACCOUNTS, [PROGRAMDATA]: null });
    await expect(loadState([PROGRAM], client.session(), createProgramCache())).rejects.toThrow(LocalLoadError);
  });

  it("falls back (LocalLoadError) for programs owned by an unsupported loader", async () => {
    const v4 = { ...ACCOUNTS, [PROGRAM]: { data: new Uint8Array(48), owner: "LoaderV411111111111111111111111111111111111", executable: true, lamports: 1 } };
    await expect(loadState([PROGRAM], fakeRpc(v4).client.session(), createProgramCache())).rejects.toThrow(/unsupported loader/);
  });

  it("uses the account data itself for older loaders, and skips native builtins", async () => {
    const direct = {
      ...ACCOUNTS,
      [PROGRAM]: { data: ELF, owner: "BPFLoader2111111111111111111111111111111111", executable: true, lamports: 1 },
      [WALLET]: { data: new Uint8Array(), owner: "NativeLoader1111111111111111111111111111111", executable: true, lamports: 1 },
    };
    const state = await loadState([WALLET, PROGRAM], fakeRpc(direct).client.session(), createProgramCache());
    expect(state.programs).toEqual([
      { programId: PROGRAM, elf: ELF, deploySlot: 0n, loader: "BPFLoader2111111111111111111111111111111111" },
    ]);
  });

  it("re-fetches a cached program whose header can no longer be read", async () => {
    const cache = createProgramCache();
    await loadState([PROGRAM], fakeRpc().client.session(), cache);
    const { client, calls } = fakeRpc(ACCOUNTS, { nullOnSlice: true });
    const state = await loadState([PROGRAM], client.session(), cache);
    expect(calls.map((c) => c.slice)).toEqual([null, { offset: 0, length: 45 }, null]); // header missing -> full fetch
    expect(state.programs).toEqual([{ programId: PROGRAM, elf: ELF, deploySlot: 100n }]);
  });

  it("rejects a programdata account with the wrong tag", async () => {
    const bad = { ...ACCOUNTS, [PROGRAMDATA]: { data: new Uint8Array(60), owner: UPGRADEABLE_LOADER, executable: false, lamports: 1 } };
    await expect(loadState([PROGRAM], fakeRpc(bad).client.session(), createProgramCache())).rejects.toThrow(LocalLoadError);
  });

  it("evicts least-recently-used programs beyond the byte budget", () => {
    const cache = createProgramCache(10);
    cache.put("a" as Address, { deploySlot: 1n, elf: new Uint8Array(6) });
    cache.put("b" as Address, { deploySlot: 1n, elf: new Uint8Array(6) });
    expect(cache.get("a" as Address)).toBeUndefined();
    expect(cache.get("b" as Address)?.deploySlot).toBe(1n);
  });
});
