import { makeError, type ErrorResponse, type Session, type WebEnv } from "@soltracer/shared";
import { simulateRequestSchema, simulationResultSchema, type SimulationResult } from "@soltracer/shared/simulation";
import { callEngine, type EngineResult } from "./engine-client.ts";

export interface SimulateRouteInput {
  session: Session | null;
  /** Parsed JSON body, or undefined when the body was not JSON. */
  body: unknown;
  env: Pick<WebEnv, "ENGINE_URL" | "ENGINE_TOKEN">;
  fetchImpl?: typeof fetch;
}

/** Server-side logic for POST /api/simulate, kept free of Next.js request objects for testing. */
export async function handleSimulate(input: SimulateRouteInput): Promise<EngineResult<SimulationResult>> {
  // Defence in depth: proxy.ts already refuses /api/* without a session.
  if (!input.session) return { status: 401, body: makeError("UNAUTHORIZED", "Sign in first.") };

  const parsed = simulateRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    const error: ErrorResponse = makeError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid request body.",
      { issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })) },
    );
    return { status: 400, body: error };
  }

  return callEngine(
    input.env,
    "/simulate",
    { method: "POST", body: parsed.data, wallet: input.session.publicKey },
    simulationResultSchema,
    input.fetchImpl,
  );
}
