import { readFileSync } from "node:fs";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { createMemoryCaches } from "../../src/cache/memory.ts";
import { createRpcClient, type RpcCallRecord } from "../../src/rpc/client.ts";
import { createRateLimiter } from "../../src/rpc/rate-limiter.ts";
import { createReplayTransport, parseRecordedJson } from "../../src/rpc/replay.ts";
import { loadIdl, loadIdlErrors } from "../../src/sim/common.ts";

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

const recorded = (
  parseRecordedJson(readFileSync(new URL("../fixtures/idl/jupiter-v6.idl.json", import.meta.url), "utf8")) as { rpc: RpcCallRecord[] }
).rpc;

describe("loadIdl", () => {
  it("keeps the error table and the decoding IDL from one account read, then serves both from cache", async () => {
    const { session: s } = session(recorded);
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
    const [first] = recorded;
    if (!first) throw new Error("no recorded call");
    const missing = { ...first, response: { jsonrpc: "2.0", result: { context: { slot: 1n }, value: null } } } as RpcCallRecord;
    const { session: s } = session([missing]);
    const caches = createMemoryCaches();
    expect(await loadIdl(s, caches, JUP)).toEqual({ found: false });
    expect(await caches.idls.get(JUP)).toEqual({ found: false });
  });
});
