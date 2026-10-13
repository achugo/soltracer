import { z } from "zod";

export const errorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "NONCE_INVALID",
  "NONCE_EXPIRED",
  "NONCE_USED",
  "BAD_MESSAGE",
  "BAD_SIGNATURE",
  "NOT_ALLOWLISTED",
  "ENGINE_UNAVAILABLE",
  "INTERNAL",
]);

export const errorResponseSchema = z.object({
  ok: z.literal(false),
  code: errorCodeSchema,
  message: z.string(),
  details: z.unknown(),
});

export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export function makeError(code: ErrorCode, message: string, details: unknown = null): ErrorResponse {
  return { ok: false, code, message, details };
}
