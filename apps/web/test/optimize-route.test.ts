import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { handleOptimize } from "../lib/optimize-route.ts";
import { handleTxStatus } from "../lib/tx-status-route.ts";
import { PAYER } from "./fixtures-simulation.ts";
import { optimizeResult } from "./fixtures-optimize.ts";

const env = { ENGINE_URL: "http://127.0.0.1:4000", ENGINE_TOKEN: "t".repeat(32) };
const session = { publicKey: PAYER, signedInAt: "2026-10-13T12:00:00.000Z" };
const SIG = bs58.encode(new Uint8Array(64).fill(7));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function recordingFetch(status: number, body: unknown) {
  const calls: Request[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return json(status, body);
  };
  return { calls, fetchImpl };
}

describe("handleOptimize", () => {
  it("refuses without a session and never calls the engine", async () => {
    const { calls, fetchImpl } = recordingFetch(200, optimizeResult());
    const res = await handleOptimize({ session: null, body: { tx: "AQID" }, env, fetchImpl });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    expect(calls).toHaveLength(0);
  });

  it.each([undefined, {}, { tx: "" }, { tx: "AQID", preset: "p99" }, { tx: "AQID", extra: 1 }])(
    "rejects an invalid body %#",
    async (body) => {
      const { calls, fetchImpl } = recordingFetch(200, optimizeResult());
      const res = await handleOptimize({ session, body, env, fetchImpl });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
      expect(calls).toHaveLength(0);
    },
  );

  it("forwards the trimmed transaction with the default p75 preset, token and wallet", async () => {
    const result = optimizeResult();
    const { calls, fetchImpl } = recordingFetch(200, result);
    const res = await handleOptimize({ session, body: { tx: " AQID\n" }, env, fetchImpl });
    expect(res).toEqual({ status: 200, body: result });
    expect(calls).toHaveLength(1);
    const [req] = calls;
    expect(req?.url).toBe("http://127.0.0.1:4000/optimize");
    expect(req?.method).toBe("POST");
    expect(req?.headers.get("authorization")).toBe(`Bearer ${env.ENGINE_TOKEN}`);
    expect(req?.headers.get("x-soltracer-wallet")).toBe(PAYER);
    expect(await req?.json()).toEqual({ tx: "AQID", preset: "p75" });
  });

  it("passes OPTIMIZE_NOT_FIXABLE through with its details", async () => {
    const err = { ok: false, code: "OPTIMIZE_NOT_FIXABLE", message: "nope", details: { error: { name: "X" } } };
    const { calls, fetchImpl } = recordingFetch(422, err);
    expect(await handleOptimize({ session, body: { tx: "AQID", preset: "p90" }, env, fetchImpl })).toEqual({ status: 422, body: err });
    expect(calls).toHaveLength(1);
  });

  it("replaces an engine success that fails the schema", async () => {
    const { fetchImpl } = recordingFetch(200, { ...optimizeResult(), chosen: "p99" });
    const res = await handleOptimize({ session, body: { tx: "AQID" }, env, fetchImpl });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ ok: false, code: "INTERNAL" });
  });
});

describe("handleTxStatus", () => {
  const found = { ok: true, status: { confirmationStatus: "confirmed", err: null, slot: 300_000_001 } };

  it("refuses without a session", async () => {
    const { calls, fetchImpl } = recordingFetch(200, found);
    const res = await handleTxStatus({ session: null, body: { signature: SIG }, env, fetchImpl });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it.each([undefined, {}, { signature: "abc" }, { signature: PAYER }, { signature: SIG, extra: 1 }])(
    "rejects an invalid body %#",
    async (body) => {
      const { calls, fetchImpl } = recordingFetch(200, found);
      const res = await handleTxStatus({ session, body, env, fetchImpl });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
      expect(calls).toHaveLength(0);
    },
  );

  it("forwards the signature with the session wallet", async () => {
    const { calls, fetchImpl } = recordingFetch(200, found);
    expect(await handleTxStatus({ session, body: { signature: SIG }, env, fetchImpl })).toEqual({ status: 200, body: found });
    const [req] = calls;
    expect(req?.url).toBe("http://127.0.0.1:4000/tx-status");
    expect(req?.headers.get("x-soltracer-wallet")).toBe(PAYER);
    expect(await req?.json()).toEqual({ signature: SIG });
  });

  it("accepts a not-found status", async () => {
    const { fetchImpl } = recordingFetch(200, { ok: true, status: null });
    expect(await handleTxStatus({ session, body: { signature: SIG }, env, fetchImpl })).toEqual({
      status: 200,
      body: { ok: true, status: null },
    });
  });

  it("rejects a status without err", async () => {
    const { fetchImpl } = recordingFetch(200, { ok: true, status: { confirmationStatus: null, slot: 1 } });
    const res = await handleTxStatus({ session, body: { signature: SIG }, env, fetchImpl });
    expect(res.status).toBe(502);
  });
});
