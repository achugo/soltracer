import { errorResponseSchema, makeError, type ErrorResponse, type WebEnv } from "@soltracer/shared";
import type { z } from "zod";

const ENGINE_TIMEOUT_MS = 10_000;

export type EngineResult<T> = { status: number; body: T | ErrorResponse };

/**
 * Calls the engine with ENGINE_TOKEN and validates the reply. Server-side only.
 * Engine errors pass through; anything unexpected becomes a typed error.
 */
export async function callEngine<S extends z.ZodType>(
  env: Pick<WebEnv, "ENGINE_URL" | "ENGINE_TOKEN">,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
  schema: S,
  fetchImpl: typeof fetch = fetch,
): Promise<EngineResult<z.infer<S>>> {
  let res: Response;
  try {
    res = await fetchImpl(new URL(path, env.ENGINE_URL), {
      method: init.method,
      headers: {
        authorization: `Bearer ${env.ENGINE_TOKEN}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return { status: 503, body: makeError("ENGINE_UNAVAILABLE", "The engine is not reachable. Is it running?") };
  }

  const json: unknown = await res.json().catch(() => null);
  const ok = schema.safeParse(json);
  if (res.ok && ok.success) return { status: res.status, body: ok.data };
  const err = errorResponseSchema.safeParse(json);
  if (!res.ok && err.success) return { status: res.status, body: err.data };
  return { status: 502, body: makeError("INTERNAL", "The engine returned an unexpected response.") };
}
