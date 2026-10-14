import { errorResponseSchema, makeError, type ErrorResponse } from "@soltracer/shared/errors";
import type { z } from "zod";

/**
 * Validates a reply from this app's API. Anything that is neither a valid result nor a typed error is
 * dropped and reported as INTERNAL, so a bad payload never reaches the view. Nothing is logged: zod
 * issues would echo the payload into the browser console.
 */
export function parseApiResponse<S extends z.ZodType>(schema: S, httpOk: boolean, json: unknown): z.infer<S> | ErrorResponse {
  if (httpOk) {
    const result = schema.safeParse(json);
    if (result.success) return result.data;
  } else {
    const error = errorResponseSchema.safeParse(json);
    if (error.success) return error.data;
  }
  return makeError("INTERNAL", "The server returned an unexpected response.");
}

/** POSTs JSON to this app's API. Network failures become a typed error, never a throw. */
export async function postApi<S extends z.ZodType>(
  path: string,
  body: unknown,
  schema: S,
  fetchImpl: typeof fetch = fetch,
): Promise<z.infer<S> | ErrorResponse> {
  let res: Response;
  try {
    res = await fetchImpl(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return makeError("ENGINE_UNAVAILABLE", "Could not reach the server. Check your connection and retry.");
  }
  const json: unknown = await res.json().catch(() => null);
  return parseApiResponse(schema, res.ok, json);
}
