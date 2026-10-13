import { describe, expect, it } from "vitest";
import { handleSimulate } from "../lib/simulate-route.ts";
import { PAYER, simulationResult } from "./fixtures-simulation.ts";

const env = { ENGINE_URL: "http://127.0.0.1:4000", ENGINE_TOKEN: "t".repeat(32) };
const session = { publicKey: PAYER, signedInAt: "2026-10-13T12:00:00.000Z" };

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

describe("handleSimulate", () => {
  it("refuses a request without a session and never calls the engine", async () => {
    const { calls, fetchImpl } = recordingFetch(200, simulationResult());
    const res = await handleSimulate({ session: null, body: { tx: "AQID" }, env, fetchImpl });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    expect(calls).toHaveLength(0);
  });

  it.each([undefined, {}, { tx: "" }, { tx: "AQID", extra: 1 }, { tx: "A".repeat(6001) }])(
    "rejects an invalid body %#",
    async (body) => {
      const { calls, fetchImpl } = recordingFetch(200, simulationResult());
      const res = await handleSimulate({ session, body, env, fetchImpl });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
      expect(calls).toHaveLength(0);
    },
  );

  it("forwards the trimmed transaction with the token and session wallet", async () => {
    const result = simulationResult();
    const { calls, fetchImpl } = recordingFetch(200, result);
    const res = await handleSimulate({ session, body: { tx: "  AQID \n" }, env, fetchImpl });
    expect(res).toEqual({ status: 200, body: result });
    const [req] = calls;
    expect(req?.url).toBe("http://127.0.0.1:4000/simulate");
    expect(req?.method).toBe("POST");
    expect(req?.headers.get("authorization")).toBe(`Bearer ${env.ENGINE_TOKEN}`);
    expect(req?.headers.get("x-soltracer-wallet")).toBe(PAYER);
    expect(await req?.json()).toEqual({ tx: "AQID" });
  });

  it("passes engine errors through with their status", async () => {
    const err = { ok: false, code: "RPC_RATE_LIMITED", message: "slow down", details: null };
    const { fetchImpl } = recordingFetch(503, err);
    expect(await handleSimulate({ session, body: { tx: "AQID" }, env, fetchImpl })).toEqual({ status: 503, body: err });
  });

  it("replaces an engine success that fails the schema", async () => {
    const { fetchImpl } = recordingFetch(200, { ...simulationResult(), slot: "nope" });
    const res = await handleSimulate({ session, body: { tx: "AQID" }, env, fetchImpl });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ ok: false, code: "INTERNAL" });
  });
});
