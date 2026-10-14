import bs58 from "bs58";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOptimizeResponse, parseTxStatusResponse, postOptimize, postTxStatus } from "../lib/optimize-response.ts";
import { optimizeResult } from "./fixtures-optimize.ts";

afterEach(() => vi.restoreAllMocks());

const SIG = bs58.encode(new Uint8Array(64).fill(7));

function recorder(status: number, body: unknown) {
  const seen: Request[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(new URL(String(input), "http://localhost"), init));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { seen, fetchImpl };
}

describe("parseOptimizeResponse", () => {
  it("accepts a valid result and a typed error", () => {
    const result = optimizeResult();
    expect(parseOptimizeResponse(true, result)).toEqual(result);
    const err = { ok: false, code: "OPTIMIZE_NOT_FIXABLE", message: "no", details: null };
    expect(parseOptimizeResponse(false, err)).toEqual(err);
  });

  it("drops an invalid payload as INTERNAL without logging it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseOptimizeResponse(true, { ...optimizeResult(), presets: {} })).toMatchObject({ code: "INTERNAL" });
    expect(parseOptimizeResponse(false, "<html>")).toMatchObject({ code: "INTERNAL" });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("postOptimize", () => {
  it("posts once to this app's API with the preset", async () => {
    const { seen, fetchImpl } = recorder(200, optimizeResult());
    expect(await postOptimize("AQID", "p75", fetchImpl)).toEqual(optimizeResult());
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]?.url ?? "").pathname).toBe("/api/optimize");
    expect(await seen[0]?.json()).toEqual({ tx: "AQID", preset: "p75" });
  });

  it("does not retry after a retryable error", async () => {
    const { seen, fetchImpl } = recorder(503, { ok: false, code: "RPC_RATE_LIMITED", message: "slow", details: null });
    expect(await postOptimize("AQID", "p75", fetchImpl)).toMatchObject({ code: "RPC_RATE_LIMITED" });
    expect(seen).toHaveLength(1);
  });

  it("turns a network failure into ENGINE_UNAVAILABLE", async () => {
    const fetchImpl = async () => {
      throw new TypeError("offline");
    };
    expect(await postOptimize("AQID", "p75", fetchImpl)).toMatchObject({ ok: false, code: "ENGINE_UNAVAILABLE" });
  });
});

describe("tx status", () => {
  it("parses found, not found and invalid replies", () => {
    const found = { ok: true, status: { confirmationStatus: "finalized", err: null, slot: 5 } };
    expect(parseTxStatusResponse(true, found)).toEqual(found);
    expect(parseTxStatusResponse(true, { ok: true, status: null })).toEqual({ ok: true, status: null });
    expect(parseTxStatusResponse(true, { ok: true, status: { slot: -1 } })).toMatchObject({ code: "INTERNAL" });
  });

  it("posts the signature to /api/tx-status", async () => {
    const { seen, fetchImpl } = recorder(200, { ok: true, status: null });
    await postTxStatus(SIG, fetchImpl);
    expect(new URL(seen[0]?.url ?? "").pathname).toBe("/api/tx-status");
    expect(await seen[0]?.json()).toEqual({ signature: SIG });
  });
});
