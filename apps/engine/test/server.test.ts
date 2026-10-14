import { buildLoginMessage, errorResponseSchema, nonceResponseSchema, NONCE_TTL_MS } from "@soltracer/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcAbortedError, RpcError } from "../src/rpc/client.ts";
import { buildServer } from "../src/server.ts";
import { allowed, ENGINE_TOKEN, stranger, testConfig } from "./helpers/fixtures.ts";
import { MemoryNonceStore } from "./helpers/memory-nonce-store.ts";

const auth = { authorization: `Bearer ${ENGINE_TOKEN}` };
const DOMAIN = "127.0.0.1:3000";
let app: FastifyInstance;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
  app = buildServer({ config: testConfig, nonceStore: new MemoryNonceStore(), logger: false });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.useRealTimers();
});

async function issueNonce() {
  const res = await app.inject({ method: "POST", url: "/auth/nonce", headers: auth });
  expect(res.statusCode).toBe(200);
  return nonceResponseSchema.parse(res.json());
}

async function verify(body: unknown) {
  const res = await app.inject({ method: "POST", url: "/auth/verify", headers: auth, payload: body as object });
  return { status: res.statusCode, body: res.json() as unknown };
}

async function signedRequest(signer: typeof allowed) {
  const { nonce, issuedAt } = await issueNonce();
  const message = buildLoginMessage(DOMAIN, nonce, issuedAt);
  return { publicKey: signer.publicKey, signature: signer.sign(message), message, domain: DOMAIN };
}

describe("ENGINE_TOKEN", () => {
  it.each([
    ["missing", {}],
    ["wrong", { authorization: `Bearer ${"x".repeat(40)}` }],
    ["wrong scheme", { authorization: ENGINE_TOKEN }],
    ["prefix of the real token", { authorization: `Bearer ${ENGINE_TOKEN.slice(0, 10)}` }],
  ])("refuses a %s token with a typed 401", async (_label, headers) => {
    for (const url of ["/health", "/auth/nonce", "/does-not-exist"]) {
      const res = await app.inject({ method: url === "/health" ? "GET" : "POST", url, headers });
      expect(res.statusCode).toBe(401);
      expect(errorResponseSchema.parse(res.json()).code).toBe("UNAUTHORIZED");
    }
  });

  it("accepts the right token", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("returns a typed 404 for unknown routes once authenticated", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/nope",
      headers: { ...auth, "x-soltracer-wallet": allowed.publicKey },
    });
    expect(res.statusCode).toBe(404);
    expect(errorResponseSchema.parse(res.json()).code).toBe("NOT_FOUND");
  });
});

describe("POST /auth/nonce", () => {
  it("issues a unique nonce that expires in 5 minutes", async () => {
    const a = await issueNonce();
    const b = await issueNonce();
    expect(a.nonce).not.toBe(b.nonce);
    expect(Date.parse(a.expiresAt) - Date.parse(a.issuedAt)).toBe(NONCE_TTL_MS);
    expect(a.issuedAt).toBe("2026-10-13T12:00:00.000Z");
  });
});

describe("POST /auth/verify", () => {
  it("signs in an allowlisted wallet", async () => {
    const res = await verify(await signedRequest(allowed));
    expect(res).toEqual({ status: 200, body: { ok: true, publicKey: allowed.publicKey } });
  });

  it("refuses a non-allowlisted wallet with a clear message", async () => {
    const res = await verify(await signedRequest(stranger));
    expect(res.status).toBe(403);
    const err = errorResponseSchema.parse(res.body);
    expect(err.code).toBe("NOT_ALLOWLISTED");
    expect(err.message).toMatch(/not on the allowlist/i);
  });

  it("refuses a reused nonce", async () => {
    const req = await signedRequest(allowed);
    expect((await verify(req)).status).toBe(200);
    const res = await verify(req);
    expect(res.status).toBe(401);
    expect(errorResponseSchema.parse(res.body).code).toBe("NONCE_USED");
  });

  it("refuses an expired nonce", async () => {
    const req = await signedRequest(allowed);
    vi.setSystemTime(Date.now() + NONCE_TTL_MS);
    const res = await verify(req);
    expect(res.status).toBe(401);
    expect(errorResponseSchema.parse(res.body).code).toBe("NONCE_EXPIRED");
  });

  it("accepts a nonce just before expiry", async () => {
    const req = await signedRequest(allowed);
    vi.setSystemTime(Date.now() + NONCE_TTL_MS - 1);
    expect((await verify(req)).status).toBe(200);
  });

  it("refuses a nonce the engine never issued", async () => {
    const message = buildLoginMessage(DOMAIN, "1111111111111111111111", "2026-10-13T12:00:00.000Z");
    const res = await verify({ publicKey: allowed.publicKey, signature: allowed.sign(message), message, domain: DOMAIN });
    expect(res.status).toBe(401);
    expect(errorResponseSchema.parse(res.body).code).toBe("NONCE_INVALID");
  });

  it("refuses a signature from a different key", async () => {
    const req = await signedRequest(allowed);
    const res = await verify({ ...req, signature: stranger.sign(req.message) });
    expect(res.status).toBe(401);
    expect(errorResponseSchema.parse(res.body).code).toBe("BAD_SIGNATURE");
  });

  it("does not spend the nonce when the signature is bad", async () => {
    const req = await signedRequest(allowed);
    await verify({ ...req, signature: stranger.sign(req.message) });
    expect((await verify(req)).status).toBe(200);
  });

  it("refuses a message whose Issued time differs from the issued nonce", async () => {
    const { nonce } = await issueNonce();
    const message = buildLoginMessage(DOMAIN, nonce, "2026-10-13T11:59:00.000Z");
    const res = await verify({ publicKey: allowed.publicKey, signature: allowed.sign(message), message, domain: DOMAIN });
    expect(res.status).toBe(400);
    expect(errorResponseSchema.parse(res.body).code).toBe("BAD_MESSAGE");
  });

  it("refuses a message signed for another domain without spending the nonce", async () => {
    const { nonce, issuedAt } = await issueNonce();
    const message = buildLoginMessage("evil.example", nonce, issuedAt);
    const forged = { publicKey: allowed.publicKey, signature: allowed.sign(message), message, domain: DOMAIN };
    const res = await verify(forged);
    expect(res.status).toBe(400);
    const err = errorResponseSchema.parse(res.body);
    expect(err.code).toBe("BAD_MESSAGE");
    expect(err.message).toMatch(/different site/i);

    const genuine = buildLoginMessage(DOMAIN, nonce, issuedAt);
    const ok = await verify({ ...forged, message: genuine, signature: allowed.sign(genuine) });
    expect(ok.status).toBe(200);
  });

  it("requires the domain field from the web app", async () => {
    const { publicKey, signature, message } = await signedRequest(allowed);
    const res = await verify({ publicKey, signature, message });
    expect(res.status).toBe(400);
    expect(errorResponseSchema.parse(res.body).code).toBe("VALIDATION_ERROR");
  });

  it("refuses a malformed message", async () => {
    const message = "please let me in";
    const res = await verify({ publicKey: allowed.publicKey, signature: allowed.sign(message), message, domain: DOMAIN });
    expect(res.status).toBe(400);
    expect(errorResponseSchema.parse(res.body).code).toBe("BAD_MESSAGE");
  });

  it("rejects an invalid body with VALIDATION_ERROR and no stack trace", async () => {
    const res = await verify({ publicKey: "nope" });
    expect(res.status).toBe(400);
    const err = errorResponseSchema.parse(res.body);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(res.body)).not.toMatch(/\bat .+\.ts:\d+/);
  });

  it("rejects non-JSON bodies with a typed error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { ...auth, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(errorResponseSchema.parse(res.json()).code).toBe("VALIDATION_ERROR");
  });
});

describe("oversized bodies", () => {
  it("keeps the 413 status with a typed error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { ...auth, "content-type": "application/json" },
      payload: JSON.stringify({ message: "x".repeat(70 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(errorResponseSchema.parse(res.json()).code).toBe("VALIDATION_ERROR");
  });
});

describe("internal errors", () => {
  it("returns INTERNAL without leaking the error message or stack", async () => {
    const failing = buildServer({
      config: testConfig,
      nonceStore: {
        create: () => Promise.reject(new Error("db password is hunter2")),
        consume: () => Promise.reject(new Error("db down")),
      },
      logger: false,
    });
    const res = await failing.inject({ method: "POST", url: "/auth/nonce", headers: auth });
    await failing.close();
    expect(res.statusCode).toBe(500);
    const err = errorResponseSchema.parse(res.json());
    expect(err.code).toBe("INTERNAL");
    expect(res.body).not.toContain("hunter2");
  });
});

describe("session wallet re-check", () => {
  async function withProbe(headers: Record<string, string>) {
    const probed = buildServer({ config: testConfig, nonceStore: new MemoryNonceStore(), logger: false });
    probed.get("/probe", async () => ({ ok: true }));
    const res = await probed.inject({ method: "GET", url: "/probe?x=1", headers: { ...auth, ...headers } });
    await probed.close();
    return { status: res.statusCode, body: res.json() as unknown };
  }

  it("lets an allowlisted session wallet through", async () => {
    expect(await withProbe({ "x-soltracer-wallet": allowed.publicKey })).toEqual({ status: 200, body: { ok: true } });
  });

  it("refuses a wallet removed from the allowlist since sign-in", async () => {
    const res = await withProbe({ "x-soltracer-wallet": stranger.publicKey });
    expect(res.status).toBe(403);
    expect(errorResponseSchema.parse(res.body).code).toBe("NOT_ALLOWLISTED");
  });

  it("refuses a missing or malformed wallet header", async () => {
    const attempts: Record<string, string>[] = [{}, { "x-soltracer-wallet": "nope" }];
    for (const headers of attempts) {
      const res = await withProbe(headers);
      expect(res.status).toBe(401);
      expect(errorResponseSchema.parse(res.body).code).toBe("UNAUTHORIZED");
    }
  });

  it("asks for a wallet before revealing whether a route exists", async () => {
    const res = await app.inject({ method: "GET", url: "/nope", headers: auth });
    expect(res.statusCode).toBe(401);
    expect(errorResponseSchema.parse(res.json()).code).toBe("UNAUTHORIZED");
  });

  it("only exempts the exact public paths", async () => {
    for (const url of ["/health/", "/%68ealth", "/auth/nonce/"]) {
      const res = await app.inject({ method: "GET", url, headers: auth });
      expect(res.statusCode).toBe(401);
    }
  });

  it("does not require a wallet for /health and sign-in routes", async () => {
    expect((await app.inject({ method: "GET", url: "/health", headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/nonce", headers: auth })).statusCode).toBe(200);
  });
});

describe("POST /simulate", () => {
  const wallet = { "x-soltracer-wallet": allowed.publicKey };

  async function withSimulate(simulate: NonNullable<Parameters<typeof buildServer>[0]["simulate"]>, payload: unknown) {
    const server = buildServer({ config: testConfig, nonceStore: new MemoryNonceStore(), logger: false, simulate });
    const res = await server.inject({ method: "POST", url: "/simulate", headers: { ...auth, ...wallet }, payload: payload as object });
    await server.close();
    return { status: res.statusCode, body: res.json() as unknown };
  }

  it("validates the body before simulating", async () => {
    let called = false;
    const sim = async () => {
      called = true;
      throw new Error("should not run");
    };
    for (const payload of [{}, { tx: "" }, { tx: "A".repeat(6001) }, { tx: "AQID", extra: 1 }]) {
      const res = await withSimulate(sim, payload);
      expect(res.status).toBe(400);
      expect(errorResponseSchema.parse(res.body).code).toBe("VALIDATION_ERROR");
    }
    expect(called).toBe(false);
  });

  it("passes the trimmed transaction through and returns the simulator's typed errors", async () => {
    let seen = "";
    const res = await withSimulate(async (tx) => {
      seen = tx;
      return { ok: false, status: 400, error: { ok: false, code: "TX_DECODE_FAILED", message: "nope", details: { tried: [] } } };
    }, { tx: "  AQID  " });
    expect(seen).toBe("AQID");
    expect(res).toEqual({ status: 400, body: { ok: false, code: "TX_DECODE_FAILED", message: "nope", details: { tried: [] } } });
  });

  it("maps RPC rate limiting to 503 and other RPC failures to 502, without internals", async () => {
    const limited = await withSimulate(async () => {
      throw new RpcError("RPC_RATE_LIMITED", "simulateTransaction", "simulateTransaction failed: 429");
    }, { tx: "AQID" });
    expect(limited.status).toBe(503);
    expect(errorResponseSchema.parse(limited.body)).toMatchObject({ code: "RPC_RATE_LIMITED", details: { method: "simulateTransaction" } });

    const failed = await withSimulate(async () => {
      throw new RpcError("RPC_ERROR", "getMultipleAccounts", "getMultipleAccounts returned an error: boom", { jsonRpcCode: -32005 });
    }, { tx: "AQID" });
    expect(failed.status).toBe(502);
    expect(errorResponseSchema.parse(failed.body)).toMatchObject({
      code: "RPC_ERROR",
      details: { method: "getMultipleAccounts", jsonRpcCode: -32005 },
    });
  });

  it("gives the simulator an abort signal that stays live for a normal request", async () => {
    let signal: AbortSignal | undefined;
    await withSimulate(async (_tx, _log, s) => {
      signal = s;
      return { ok: false, status: 400, error: { ok: false, code: "TX_DECODE_FAILED", message: "x", details: null } };
    }, { tx: "AQID" });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("aborts the simulator's signal when a real HTTP client disconnects mid-request", async () => {
    let resolveSeen: (s: AbortSignal) => void = () => undefined;
    const seen = new Promise<AbortSignal>((r) => (resolveSeen = r));
    const server = buildServer({
      config: testConfig,
      nonceStore: new MemoryNonceStore(),
      logger: false,
      simulate: (_tx, _log, signal) => {
        resolveSeen(signal);
        return new Promise(() => undefined); // never finishes on its own
      },
    });
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    try {
    const client = new AbortController();
    const request = fetch(`${address}/simulate`, {
      method: "POST",
      headers: { ...auth, ...wallet, "content-type": "application/json" },
      body: JSON.stringify({ tx: "AQID" }),
      signal: client.signal,
    }).catch(() => undefined);
    const signal = await seen;
    expect(signal.aborted).toBe(false);
    client.abort();
    await request;
    await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 2000, interval: 10 });
    } finally {
      await server.close();
    }
  });

  it("answers 499 with a typed error when the RPC work was cancelled", async () => {
    const res = await withSimulate(async () => {
      throw new RpcAbortedError("getBalance");
    }, { tx: "AQID" });
    expect(res.status).toBe(499);
    expect(errorResponseSchema.parse(res.body).code).toBe("ENGINE_UNAVAILABLE");
  });

  it("is unavailable when the engine was started without a simulator", async () => {
    const res = await app.inject({ method: "POST", url: "/simulate", headers: { ...auth, ...wallet }, payload: { tx: "AQID" } });
    expect(res.statusCode).toBe(404);
  });
});
