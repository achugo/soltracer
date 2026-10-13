import { errorResponseSchema, makeError, type ErrorResponse } from "@soltracer/shared/errors";
import { simulationResultSchema, type SimulationResult } from "@soltracer/shared/simulation";

export type SimulateOutcome = SimulationResult | ErrorResponse;

/**
 * Validates a `/api/simulate` reply. Anything that is neither a valid result nor a typed error is
 * dropped with a warning and reported as INTERNAL, so a bad payload never reaches the view.
 */
export function parseSimulateResponse(httpOk: boolean, json: unknown): SimulateOutcome {
  if (httpOk) {
    const result = simulationResultSchema.safeParse(json);
    if (result.success) return result.data;
    console.warn("Dropped an invalid simulation result", result.error.issues);
  } else {
    const error = errorResponseSchema.safeParse(json);
    if (error.success) return error.data;
    console.warn("Dropped an invalid error response", error.error.issues);
  }
  return makeError("INTERNAL", "The server returned an unexpected response.");
}

/** Posts the transaction to this app's API. Network failures become a typed error, never a throw. */
export async function postSimulate(tx: string, fetchImpl: typeof fetch = fetch): Promise<SimulateOutcome> {
  let res: Response;
  try {
    res = await fetchImpl("/api/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx }),
      cache: "no-store",
    });
  } catch {
    return makeError("ENGINE_UNAVAILABLE", "Could not reach the server. Check your connection and retry.");
  }
  const json: unknown = await res.json().catch(() => null);
  return parseSimulateResponse(res.ok, json);
}
