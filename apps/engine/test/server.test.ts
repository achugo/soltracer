import { buildLoginMessage, errorResponseSchema, nonceResponseSchema, NONCE_TTL_MS } from "@soltracer/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    const res = await app.inject({ method: "GET", url: "/nope", headers: auth });
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
