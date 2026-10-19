import { deflateSync } from "node:zlib";
import { address } from "@solana/kit";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryCaches } from "../../src/cache/memory.ts";
import { createPgCaches } from "../../src/cache/pg.ts";
import type { SandboxCaches } from "../../src/cache/types.ts";
import { createDb } from "../../src/db/client.ts";
import { migrateUp } from "../../src/db/migrations.ts";
import { MAX_DECODED_CHARS } from "../../src/decode/borsh.ts";
import { anchorIdlAddress } from "../../src/decode/idl-address.ts";
import { decodeIdlInstruction, normalizeIdl } from "../../src/decode/idl-full.ts";
import { IdlParseError } from "../../src/decode/idl.ts";
import { createRpcClient, type RpcCallRecord } from "../../src/rpc/client.ts";
import { createRateLimiter } from "../../src/rpc/rate-limiter.ts";
import { createReplayTransport } from "../../src/rpc/replay.ts";
import { loadDecodingIdls } from "../../src/sim/common.ts";
import { MAX_DECODED_OUTPUT_CHARS, withoutInvalidDecoding } from "../../src/trace/schema-safe.ts";
import { TEST_DATABASE_URL } from "../helpers/test-db.ts";

const PROGRAM = address("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

/** An Anchor IDL account holding `json`: discriminator, authority, length, zlib data. */
function idlAccountData(json: unknown): Uint8Array {
  const body = deflateSync(Buffer.from(JSON.stringify(json)));
  const header = Buffer.alloc(44);
  header.writeUInt32LE(body.length, 40);
  return new Uint8Array(Buffer.concat([header, body]));
}

/** loadDecodingIdls against one batched read that returns `json` as the program's IDL account. */
async function loadHostile(json: unknown, caches: SandboxCaches) {
  const record = {
    method: "getMultipleAccounts",
    params: [[await anchorIdlAddress(PROGRAM)], { encoding: "base64", commitment: "confirmed" }],
    response: {
      jsonrpc: "2.0",
      result: {
        context: { slot: 1n },
        value: [{ data: [Buffer.from(idlAccountData(json)).toString("base64"), "base64"], executable: false, lamports: 1n, owner: PROGRAM, rentEpoch: 0n, space: 0n }],
      },
    },
  } as RpcCallRecord;
  const session = createRpcClient({
    url: "https://replay.invalid",
    limiter: createRateLimiter({ limit: 1000, windowMs: 1000 }),
    transport: createReplayTransport([record]),
    log: { info: () => undefined, warn: () => undefined },
  }).session();
  return loadDecodingIdls(session, caches, [PROGRAM], "fetch");
}

const ix = (extra: Record<string, unknown> = {}) => ({ name: "swap", discriminator: [1], accounts: [{ name: "pool" }], args: [], ...extra });

describe("hostile IDLs: output stays small", () => {
  it("a 200 KB variant name renders raw instead of multiplying out (audit H1)", () => {
    const idl = normalizeIdl({
      instructions: [ix({ args: [{ name: "a", type: { array: [{ defined: { name: "E" } }, 1000] } }] })],
      types: [{ name: "E", type: { kind: "enum", variants: [{ name: "x".repeat(200_000) }] } }],
    });
    const started = Date.now();
    expect(decodeIdlInstruction(idl, Uint8Array.from([1, ...new Uint8Array(1000)]), 1)).toBeNull();
    expect(Date.now() - started).toBeLessThan(50);
  });

  it(`decoded output past ${MAX_DECODED_CHARS} characters renders raw`, () => {
    const idl = normalizeIdl({ instructions: [ix({ args: [{ name: "b", type: { vec: "bytes" } }] })] });
    const item = [0, 4, 0, 0, ...new Uint8Array(1024)]; // u32 1024, then 1 KB of bytes -> 2 KB of hex each
    const data = (count: number) => Uint8Array.from([1, count, 0, 0, 0, ...Array.from({ length: count }, () => item).flat()]);
    expect(decodeIdlInstruction(idl, data(20), 1)).not.toBeNull(); // 40 K characters: within budget
    expect(decodeIdlInstruction(idl, data(40), 1)).toBeNull(); // 80 K characters: renders raw
  });

  it("identifiers longer than 128 characters, or too many entries, reject the IDL", () => {
    expect(() => normalizeIdl({ instructions: [ix({ name: "y".repeat(129) })] })).toThrow(IdlParseError);
    expect(() => normalizeIdl({ instructions: [ix({ accounts: [{ name: "g".repeat(1_000_000), accounts: [{ name: "a" }] }] })] })).toThrow(IdlParseError);
    expect(() => normalizeIdl({ instructions: Array.from({ length: 2001 }, (_, i) => ix({ name: `i${i}` })) })).toThrow(IdlParseError);
  });

  it("normalizing a large legacy IDL is linear, not quadratic (audit M1)", () => {
    const n = 2000;
    const started = Date.now();
    normalizeIdl({
      instructions: [],
      accounts: Array.from({ length: n }, (_, i) => ({ name: `A${i}`, type: { kind: "struct" } })),
      types: Array.from({ length: n }, (_, i) => ({ name: `T${i}`, type: { kind: "struct" } })),
    });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it(`a trace whose decoded parts exceed ${MAX_DECODED_OUTPUT_CHARS} characters renders raw`, () => {
    const big = { name: "swap", args: { s: "z".repeat(MAX_DECODED_OUTPUT_CHARS) }, accountNames: [] };
    const node = {
      id: 0, parent: null, depth: 1, instructionIndex: 0, programId: PROGRAM, status: "success" as const, consumed: null, budget: null,
      selfConsumed: null, error: null, logs: [], logsDropped: 0, returnData: null, instruction: { data: "01", accounts: [], decoded: big },
    };
    const trace = withoutInvalidDecoding({ nodes: [node], failingNodeId: null, complete: true });
    expect(trace.nodes[0]?.instruction?.decoded).toBeNull();
  });
});

describe("hostile IDLs can't fail a run or dodge the cache (audit H2)", () => {
  const { db, close } = createDb(TEST_DATABASE_URL);
  beforeAll(async () => {
    await migrateUp(db);
    await db.execute(sql`truncate idl_cache`);
  });
  afterAll(close);

  it("names with U+0000 and lone surrogates are stored cleaned, and served from cache afterwards", async () => {
    const caches = createPgCaches(db);
    const idls = await loadHostile(
      { instructions: [ix({ name: "sw\u0000ap", args: [{ name: "a\ud800", type: "u8" }] })], errors: [{ code: 6000, name: "E\u0000", msg: "m\udc00" }] },
      caches,
    );
    expect(idls.get(PROGRAM)?.instructions[0]?.name).toBe("sw�ap");
    const cached = await caches.idls.get(PROGRAM);
    expect(cached).toMatchObject({ found: true });
    if (!cached?.found) return;
    expect(cached.errors.get(6000)).toEqual({ name: "E�", message: "m�" });
    expect(cached.idl?.instructions[0]?.args[0]?.name).toBe("a�");
  });

  it("type JSON with U+0000 is stored too", async () => {
    await db.execute(sql`truncate idl_cache`);
    const caches = createPgCaches(db);
    await loadHostile({ instructions: [ix()], types: [{ name: "T", type: { kind: "struct", fields: [{ name: "f\u0000", type: "u8" }] } }] }, caches);
    expect((await caches.idls.get(PROGRAM))?.found).toBe(true);
  });

  it("an IDL that can't be decoded still records its absence, so it isn't re-read every run", async () => {
    const caches = createMemoryCaches();
    expect((await loadHostile({ instructions: [ix({ name: "y".repeat(129) })] }, caches)).size).toBe(0);
    expect(await caches.idls.get(PROGRAM)).toMatchObject({ found: true, idl: null });
  });

  it("a cache write that fails doesn't fail the run", async () => {
    const memory = createMemoryCaches();
    const caches: SandboxCaches = { ...memory, idls: { get: memory.idls.get, put: async () => Promise.reject(new Error("db down")) } };
    expect((await loadHostile({ instructions: [ix()] }, caches)).has(PROGRAM)).toBe(true);
  });
});

