import { describe, expect, it } from "vitest";
import { simulationResultSchema } from "@soltracer/shared/simulation";
import { callEngine } from "../lib/engine-client.ts";

describe("callEngine cancellation", () => {
  it("aborts the engine request when the caller's signal aborts", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }) as typeof fetch;
    const env = { ENGINE_URL: "http://127.0.0.1:4000", ENGINE_TOKEN: "t".repeat(32) };
    const res = await callEngine(env, "/simulate", { method: "POST", body: {}, signal: controller.signal }, simulationResultSchema, fetchImpl);
    expect(seen?.aborted).toBe(true);
    expect(res.status).toBe(503);
  });
});
