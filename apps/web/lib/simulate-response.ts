import type { ErrorResponse } from "@soltracer/shared/errors";
import { simulationResultSchema, type simulateRequestSchema, type SimulationResult } from "@soltracer/shared/simulation";
import type { z } from "zod";
import { parseApiResponse, postApi } from "./api-response.ts";

export type SimulateOutcome = SimulationResult | ErrorResponse;
/** What the browser sends; `engine` and `overrides` default on the server when omitted. */
export type SimulateInput = z.input<typeof simulateRequestSchema>;

/** Validates a `/api/simulate` reply; see `parseApiResponse`. */
export function parseSimulateResponse(httpOk: boolean, json: unknown): SimulateOutcome {
  return parseApiResponse(simulationResultSchema, httpOk, json);
}

/** Posts the request to this app's API. Network failures become a typed error, never a throw. */
export function postSimulate(request: SimulateInput, fetchImpl: typeof fetch = fetch): Promise<SimulateOutcome> {
  return postApi("/api/simulate", request, simulationResultSchema, fetchImpl);
}
