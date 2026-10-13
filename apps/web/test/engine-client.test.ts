import { nonceResponseSchema } from "@soltracer/shared";
import { describe, expect, it } from "vitest";
import { callEngine } from "../lib/engine-client.ts";

const env = { ENGINE_URL: "http://127.0.0.1:4000", ENGINE_TOKEN: "t".repeat(32), SESSION_SECRET: "s".repeat(32) };
const nonce = { ok: true, nonce: "4vJ9JU1bJJE96FWSJKvHsm", issuedAt: "2026-10-13T12:00:00.000Z", expiresAt: "2026-10-13T12:05:00.000Z" };

const respond = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("callEngine", () => {
  it("sends the engine token and parses a success body", async () => {
    let seen: Request | undefined;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(input, init);
      return respond(200, nonce)();
    };
    const res = await callEngine(env, "/auth/nonce", { method: "POST" }, nonceResponseSchema, fetchImpl);
    expect(res).toEqual({ status: 200, body: nonce });
    expect(seen?.url).toBe("http://127.0.0.1:4000/auth/nonce");
    expect(seen?.headers.get("authorization")).toBe(`Bearer ${env.ENGINE_TOKEN}`);
  });

  it("passes typed engine errors through with their status", async () => {
    const err = { ok: false, code: "NOT_ALLOWLISTED", message: "nope", details: null };
    const res = await callEngine(env, "/auth/verify", { method: "POST" }, nonceResponseSchema, respond(403, err));
    expect(res).toEqual({ status: 403, body: err });
  });

  it("maps an unexpected body to INTERNAL without echoing it", async () => {
    const res = await callEngine(env, "/auth/nonce", { method: "POST" }, nonceResponseSchema, respond(200, { secret: "x" }));
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("maps a network failure to ENGINE_UNAVAILABLE", async () => {
    const res = await callEngine(env, "/auth/nonce", { method: "POST" }, nonceResponseSchema, async () => {
      throw new TypeError("fetch failed");
    });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, code: "ENGINE_UNAVAILABLE" });
  });
});
