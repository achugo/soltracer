import { makeError, type ErrorResponse, type Session, type WebEnv } from "@soltracer/shared";
import type { z } from "zod";
import { callEngine, type EngineResult } from "./engine-client.ts";

export interface EngineRouteInput {
  session: Session | null;
  /** Parsed JSON body, or undefined when the body was not JSON. */
  body: unknown;
  env: Pick<WebEnv, "ENGINE_URL" | "ENGINE_TOKEN">;
  fetchImpl?: typeof fetch;
}

export interface EngineRouteSpec<Req extends z.ZodType, Res extends z.ZodType> {
  path: string;
  request: Req;
  response: Res;
  timeoutMs?: number;
}

/**
 * Shared logic for session-checked POST proxies to the engine: refuse without a session, validate the
 * body with the shared schema, then forward it with ENGINE_TOKEN and the session wallet.
 */
export async function proxyToEngine<Req extends z.ZodType, Res extends z.ZodType>(
  spec: EngineRouteSpec<Req, Res>,
  input: EngineRouteInput,
): Promise<EngineResult<z.infer<Res>>> {
  // Defence in depth: proxy.ts already refuses /api/* without a session.
  if (!input.session) return { status: 401, body: makeError("UNAUTHORIZED", "Sign in first.") };

  const parsed = spec.request.safeParse(input.body);
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
    spec.path,
    { method: "POST", body: parsed.data, wallet: input.session.publicKey, timeoutMs: spec.timeoutMs },
    spec.response,
    input.fetchImpl,
  );
}
