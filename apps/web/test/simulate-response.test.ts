import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSimulateResponse, postSimulate } from "../lib/simulate-response.ts";
import { simulationResult } from "./fixtures-simulation.ts";

afterEach(() => vi.restoreAllMocks());

const json = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("parseSimulateResponse", () => {
  it("accepts a valid result", () => {
    const result = simulationResult();
    expect(parseSimulateResponse(true, result)).toEqual(result);
  });

  it("accepts a typed error", () => {
    const err = { ok: false, code: "RPC_RATE_LIMITED", message: "slow down", details: null };
    expect(parseSimulateResponse(false, err)).toEqual(err);
  });

  it("drops an invalid result without logging it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bad = { ...simulationResult(), unitsConsumed: -1 };
    expect(parseSimulateResponse(true, bad)).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops an unknown error shape without logging it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseSimulateResponse(false, "<html>")).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("postSimulate", () => {
  it("posts the transaction to this app's API", async () => {
    let seen: Request | undefined;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(new URL(String(input), "http://localhost"), init);
      return json(200, simulationResult())();
    };
    const out = await postSimulate("AQID", fetchImpl);
    expect(out.ok).toBe(true);
    expect(seen?.url).toBe("http://localhost/api/simulate");
    expect(seen?.method).toBe("POST");
    expect(await seen?.json()).toEqual({ tx: "AQID" });
  });

  it("turns a network failure into a typed error", async () => {
    const out = await postSimulate("AQID", async () => {
      throw new TypeError("fetch failed");
    });
    expect(out).toMatchObject({ ok: false, code: "ENGINE_UNAVAILABLE" });
  });

  it("passes error statuses through as typed errors", async () => {
    const err = { ok: false, code: "TX_DECODE_FAILED", message: "nope", details: { tried: [] } };
    expect(await postSimulate("zz", json(400, err))).toEqual(err);
  });
});
