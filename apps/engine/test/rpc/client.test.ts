import { address, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError, type RpcTransport } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { getMultipleAccountsBatched } from "../../src/rpc/accounts.ts";
import { createRpcClient, RpcError, type RpcCallRecord } from "../../src/rpc/client.ts";
import { createRateLimiter } from "../../src/rpc/rate-limiter.ts";

const URL_WITH_KEY = "https://rpc.example.com/?api-key=super-secret-key-123";

type Payload = { method: string; params: unknown[]; id: string };

/** A fake inner transport that answers per method and remembers what it saw. */
function fakeTransport(answer: (p: Payload) => unknown) {
  const seen: Payload[] = [];
  const transport = (async ({ payload }: { payload: unknown }) => {
    const p = payload as Payload;
    seen.push(p);
    return { jsonrpc: "2.0", id: p.id, result: answer(p) };
  }) as RpcTransport;
  return { transport, seen };
}

function makeClient(inner: RpcTransport) {
  const logs: { obj: Record<string, unknown>; msg: string }[] = [];
  const limiter = createRateLimiter({ limit: 10, windowMs: 1000 });
  const take = vi.spyOn(limiter, "take");
  const client = createRpcClient({
    url: URL_WITH_KEY,
    limiter,
    transport: inner,
    log: { info: (obj, msg) => logs.push({ obj, msg }), warn: (obj, msg) => logs.push({ obj, msg }) },
  });
  return { client, logs, take };
}

const ACCOUNT = (lamports: number) => ({
  data: ["AQID", "base64"],
  executable: false,
  lamports,
  owner: "11111111111111111111111111111111",
  rentEpoch: 0,
  space: 3,
});

describe("createRpcClient", () => {
  it("rate-limits, meters credits per session and logs without the URL", async () => {
    const { transport } = fakeTransport(() => ({ context: { slot: 7 }, value: 5000 }));
    const { client, logs, take } = makeClient(transport);
    const session = client.session();
    await session.rpc.getBalance(address("11111111111111111111111111111111")).send();
    await session.rpc.getBalance(address("11111111111111111111111111111111")).send();

    expect(take).toHaveBeenCalledTimes(2);
    expect(session.credits()).toBe(2);
    expect(client.session().credits()).toBe(0);
    expect(logs.map((l) => l.obj)).toEqual([
      expect.objectContaining({ rpc: "getBalance", credits: 1 }),
      expect.objectContaining({ rpc: "getBalance", credits: 1 }),
    ]);
    expect(JSON.stringify(logs)).not.toContain("super-secret-key-123");
  });

  it("records method, params and response when asked", async () => {
    const { transport } = fakeTransport(() => ({ context: { slot: 7 }, value: 5000 }));
    const { client } = makeClient(transport);
    const records: RpcCallRecord[] = [];
    await client.session({ record: records }).rpc.getBalance(address("11111111111111111111111111111111")).send();
    expect(records).toHaveLength(1);
    // kit fills in the default commitment, so it is part of what gets recorded and replayed.
    expect(records[0]).toMatchObject({
      method: "getBalance",
      params: ["11111111111111111111111111111111", { commitment: "confirmed" }],
    });
    expect(records[0]?.response).toMatchObject({ result: { value: 5000 } });
  });

  it("redacts a bare api-key even when the URL differs", async () => {
    const inner = (async () => {
      throw new Error("bad request to https://other.example/?api-key=other-key-456&x=1");
    }) as RpcTransport;
    const { client } = makeClient(inner);
    const err = await client.session().rpc.getBalance(address("11111111111111111111111111111111")).send().catch((e: unknown) => e);
    expect((err as RpcError).message).toContain("api-key=***&x=1");
    expect((err as RpcError).message).not.toContain("other-key-456");
  });

  it("maps a JSON-RPC error body to RPC_ERROR with its code", async () => {
    const inner = (async ({ payload }: { payload: unknown }) => ({
      jsonrpc: "2.0",
      id: (payload as Payload).id,
      error: { code: -32602, message: `Invalid params via ${URL_WITH_KEY}` },
    })) as RpcTransport;
    const { client, logs } = makeClient(inner);
    const err = await client.session().rpc.getBalance(address("11111111111111111111111111111111")).send().catch((e: unknown) => e);
    expect((err as RpcError).code).toBe("RPC_ERROR");
    expect((err as RpcError).details).toEqual({ jsonRpcCode: -32602 });
    expect((err as RpcError).message).not.toContain("super-secret-key-123");
    expect(logs.at(-1)?.msg).toBe("rpc call returned an error");
  });

  it("handles error bodies whose numbers were parsed as bigint", async () => {
    const inner = (async ({ payload }: { payload: unknown }) => ({
      jsonrpc: "2.0",
      id: (payload as Payload).id,
      error: { code: -32009n, message: "Slot skipped", data: { slot: 123n } },
    })) as RpcTransport;
    const { client } = makeClient(inner);
    const err = await client.session().rpc.getBalance(address("11111111111111111111111111111111")).send().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).details).toEqual({ jsonRpcCode: -32009 });
  });

  it("maps HTTP 429 to RPC_RATE_LIMITED and strips the API key", async () => {
    const inner = (async () => {
      throw new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
        headers: new Headers(),
        message: `Too Many Requests for ${URL_WITH_KEY}`,
        statusCode: 429,
      });
    }) as RpcTransport;
    const { client } = makeClient(inner);
    const err = await client
      .session()
      .rpc.getBalance(address("11111111111111111111111111111111"))
      .send()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe("RPC_RATE_LIMITED");
    expect(String((err as RpcError).message)).not.toContain("super-secret-key-123");
  });

  it("maps other failures to RPC_ERROR without leaking the key", async () => {
    const inner = (async () => {
      throw new Error(`connect ECONNREFUSED ${URL_WITH_KEY}`);
    }) as RpcTransport;
    const { client } = makeClient(inner);
    const err = await client
      .session()
      .rpc.getBalance(address("11111111111111111111111111111111"))
      .send()
      .catch((e: unknown) => e);
    expect((err as RpcError).code).toBe("RPC_ERROR");
    expect((err as RpcError).method).toBe("getBalance");
    expect((err as RpcError).message).toContain("<rpc-url>");
    expect((err as RpcError).message).not.toContain("super-secret-key-123");
  });
});

describe("getMultipleAccountsBatched", () => {
  it("splits into calls of at most 100 and keeps order, including missing accounts", async () => {
    const addresses = Array.from({ length: 250 }, (_, i) =>
      address(i === 0 ? "11111111111111111111111111111111" : "SysvarRent111111111111111111111111111111111"),
    );
    const { transport, seen } = fakeTransport((p) => {
      const keys = (p.params[0] as string[]).length;
      return { context: { slot: 100 + seen.length }, value: Array.from({ length: keys }, (_, i) => (i % 2 ? null : ACCOUNT(i))) };
    });
    const { client } = makeClient(transport);
    const session = client.session();
    const result = await getMultipleAccountsBatched(session.rpc, addresses);

    expect(seen.map((p) => (p.params[0] as string[]).length)).toEqual([100, 100, 50]);
    expect(seen[0]?.params[1]).toMatchObject({ encoding: "base64", commitment: "confirmed" });
    expect(result.accounts).toHaveLength(250);
    expect(result.accounts[0]).toMatchObject({ address: addresses[0], lamports: 0n, data: new Uint8Array([1, 2, 3]) });
    expect(result.accounts[1]).toBeNull();
    expect(result.slot).toBe(103n);
    expect(session.credits()).toBe(3);
  });

  it("fails loudly if the RPC returns the wrong number of accounts", async () => {
    const { transport } = fakeTransport(() => ({ context: { slot: 1 }, value: [ACCOUNT(1)] }));
    const { client } = makeClient(transport);
    const keys = [address("11111111111111111111111111111111"), address("SysvarRent111111111111111111111111111111111")];
    await expect(getMultipleAccountsBatched(client.session().rpc, keys)).rejects.toThrow(/returned 1 accounts for 2 keys/);
  });

  it("makes no call for an empty list", async () => {
    const { transport, seen } = fakeTransport(() => null);
    const { client } = makeClient(transport);
    expect(await getMultipleAccountsBatched(client.session().rpc, [])).toEqual({ slot: null, accounts: [] });
    expect(seen).toHaveLength(0);
  });
});
