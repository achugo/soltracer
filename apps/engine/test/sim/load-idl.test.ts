import { address, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { createMemoryCaches } from "../../src/cache/memory.ts";
import { createRpcClient, type RpcCallRecord } from "../../src/rpc/client.ts";
import { createRateLimiter } from "../../src/rpc/rate-limiter.ts";
import { createReplayTransport, parseRecordedJson } from "../../src/rpc/replay.ts";
import { anchorIdlAddress } from "../../src/decode/idl-address.ts";
import { loadDecodingIdls, loadIdl, loadIdlErrors } from "../../src/sim/common.ts";
import { loadJupiterIdlFixture, present } from "../helpers/third-party.ts";

const JUP = address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

function session(records: RpcCallRecord[]) {
  const transport = createReplayTransport(records);
  const client = createRpcClient({
    url: "https://replay.invalid",
    limiter: createRateLimiter({ limit: 1000, windowMs: 1000 }),
    transport,
    log: { info: () => undefined, warn: () => undefined },
  });
  return { session: client.session(), transport };
}

// Jupiter's IDL is third-party material, kept in the local fixture cache (null when it isn't there).
const idlFixture = loadJupiterIdlFixture();
const recorded = () => (parseRecordedJson(present(idlFixture).text) as { rpc: RpcCallRecord[] }).rpc;

describe.skipIf(!idlFixture)("loadIdl", () => {
  it("keeps the error table and the decoding IDL from one account read, then serves both from cache", async () => {
    const { session: s } = session(recorded());
    const caches = createMemoryCaches();
    const entry = await loadIdl(s, caches, JUP);
    expect(entry.found).toBe(true);
    if (!entry.found) return;
    expect(entry.errors.get(6001)?.name).toBe("SlippageToleranceExceeded");
    expect(entry.idl?.instructions).toHaveLength(19);
    expect(s.credits()).toBe(1);

    expect(await loadIdl(s, caches, JUP)).toBe(entry);
    expect((await loadIdlErrors(s, caches, JUP))?.size).toBe(28);
    expect(s.credits()).toBe(1); // no second read
  });

  it("records a program without an IDL account", async () => {
    const [first] = recorded();
    if (!first) throw new Error("no recorded call");
    const missing = { ...first, response: { jsonrpc: "2.0", result: { context: { slot: 1n }, value: null } } } as RpcCallRecord;
    const { session: s } = session([missing]);
    const caches = createMemoryCaches();
    expect(await loadIdl(s, caches, JUP)).toEqual({ found: false });
    expect(await caches.idls.get(JUP)).toEqual({ found: false });
  });
});

describe("loadDecodingIdls", () => {
  const WHIRLPOOL = address("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
  const SYSTEM = address("11111111111111111111111111111111");
  const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

  /** One batched read answering with the recorded Jupiter IDL account and no Whirlpool IDL account. */
  async function batchRecord(jupiterOwner: Address = JUP): Promise<RpcCallRecord> {
    const [first] = recorded();
    if (!first) throw new Error("no recorded call");
    const idlAccount = (first.response as { result: { value: Record<string, unknown> } }).result.value;
    return {
      method: "getMultipleAccounts",
      params: [[await anchorIdlAddress(JUP), await anchorIdlAddress(WHIRLPOOL)], { encoding: "base64", commitment: "confirmed" }],
      response: { jsonrpc: "2.0", result: { context: { slot: 1n }, value: [{ ...idlAccount, owner: jupiterOwner }, null] } },
    } as RpcCallRecord;
  }

  it.skipIf(!idlFixture)("fetch: one batched read for every uncached program, builtins skipped, absence cached", async () => {
    const { session: s, transport } = session([await batchRecord()]);
    const caches = createMemoryCaches();
    const idls = await loadDecodingIdls(s, caches, [SYSTEM, JUP, TOKEN, WHIRLPOOL, JUP], "fetch");
    expect([...idls.keys()]).toEqual([JUP]);
    expect(s.credits()).toBe(1);
    expect(transport.unused()).toBe(0);
    expect(await caches.idls.get(WHIRLPOOL)).toEqual({ found: false });

    const again = await loadDecodingIdls(s, caches, [JUP, WHIRLPOOL], "fetch");
    expect([...again.keys()]).toEqual([JUP]);
    expect(s.credits()).toBe(1); // all cached now
  });

  it("cached: never reads", async () => {
    const { session: s } = session([]);
    expect((await loadDecodingIdls(s, createMemoryCaches(), [JUP, WHIRLPOOL], "cached")).size).toBe(0);
    expect(s.credits()).toBe(0);
  });

  it.skipIf(!idlFixture)("an account at the IDL address that the program doesn't own is not its IDL", async () => {
    const { session: s } = session([await batchRecord(WHIRLPOOL)]);
    const caches = createMemoryCaches();
    expect((await loadDecodingIdls(s, caches, [JUP, WHIRLPOOL], "fetch")).size).toBe(0);
    expect(await caches.idls.get(JUP)).toEqual({ found: false });
  });
});
