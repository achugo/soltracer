import { z } from "zod";
import { pubkeySchema, signatureSchema } from "./solana.ts";

export const NONCE_TTL_MS = 5 * 60 * 1000;

export const nonceSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{16,44}$/, "Invalid nonce");

export const nonceResponseSchema = z.object({
  ok: z.literal(true),
  nonce: nonceSchema,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export const verifyRequestSchema = z.strictObject({
  publicKey: pubkeySchema,
  signature: signatureSchema,
  message: z.string().max(512),
});

export const verifyResponseSchema = z.object({
  ok: z.literal(true),
  publicKey: pubkeySchema,
});

export const sessionSchema = z.object({
  publicKey: pubkeySchema,
  signedInAt: z.iso.datetime(),
});

export type NonceResponse = z.infer<typeof nonceResponseSchema>;
export type VerifyRequest = z.infer<typeof verifyRequestSchema>;
export type VerifyResponse = z.infer<typeof verifyResponseSchema>;
export type Session = z.infer<typeof sessionSchema>;

const HEADER = "SolTracer login";

/** The exact text the wallet signs to sign in. */
export function buildLoginMessage(nonce: string, issued: string): string {
  return `${HEADER}\nNonce: ${nonce}\nIssued: ${issued}`;
}

/** Inverse of buildLoginMessage; null for anything that is not exactly that shape. */
export function parseLoginMessage(message: string): { nonce: string; issued: string } | null {
  const match = /^SolTracer login\nNonce: (\S+)\nIssued: (\S+)$/.exec(message);
  if (!match) return null;
  const [, nonce, issued] = match;
  if (nonce === undefined || issued === undefined) return null;
  if (!nonceSchema.safeParse(nonce).success) return null;
  if (!z.iso.datetime().safeParse(issued).success) return null;
  return { nonce, issued };
}
