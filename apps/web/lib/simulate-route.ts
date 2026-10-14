import { simulateRequestSchema, simulationResultSchema, type SimulationResult } from "@soltracer/shared/simulation";
import type { EngineResult } from "./engine-client.ts";
import { proxyToEngine, type EngineRouteInput } from "./engine-route.ts";

export type SimulateRouteInput = EngineRouteInput;

/** Server-side logic for POST /api/simulate, kept free of Next.js request objects for testing. */
export function handleSimulate(input: SimulateRouteInput): Promise<EngineResult<SimulationResult>> {
  return proxyToEngine({ path: "/simulate", request: simulateRequestSchema, response: simulationResultSchema }, input);
}
