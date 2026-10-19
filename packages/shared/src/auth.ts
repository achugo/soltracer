import { z } from "zod";
import { pubkeySchema, signatureSchema } from "./solana.ts";

export const NONCE_TTL_MS = 5 * 60 * 1000;

const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:(\d{1,5}))?$/;

/** A request Host value: hostname or hostname:port, lowercased. No scheme, path or IPv6 literal. */
export const hostSchema = z
  .string()
  .max(260)
  .toLowerCase()
  .regex(HOST_PATTERN, "Must be a hostname or hostname:port")
  .refine((h) => {
    const port = HOST_PATTERN.exec(h)?.[5];
    return port === undefined || (Number(port) >= 1 && Number(port) <= 65535);
  }, "Port must be 1-65535");

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

/** What the web app forwards to the engine: the browser's request plus the Host it was served on. */
export const engineVerifyRequestSchema = verifyRequestSchema.extend({ domain: hostSchema });

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
export type EngineVerifyRequest = z.infer<typeof engineVerifyRequestSchema>;
export type VerifyResponse = z.infer<typeof verifyResponseSchema>;
export type Session = z.infer<typeof sessionSchema>;

const HEADER = "SolTracer login";

/** The exact text the wallet signs to sign in. The Domain line stops other sites replaying it. */
export function buildLoginMessage(domain: string, nonce: string, issued: string): string {
  return `${HEADER}\nDomain: ${domain}\nNonce: ${nonce}\nIssued: ${issued}`;
}

/** Inverse of buildLoginMessage; null for anything that is not exactly that shape. */
export function parseLoginMessage(message: string): { domain: string; nonce: string; issued: string } | null {
  const match = /^SolTracer login\nDomain: (\S+)\nNonce: (\S+)\nIssued: (\S+)$/.exec(message);
  if (!match) return null;
  const [, domain, nonce, issued] = match;
  if (domain === undefined || nonce === undefined || issued === undefined) return null;
  const host = hostSchema.safeParse(domain);
  if (!host.success || host.data !== domain) return null;
  if (!nonceSchema.safeParse(nonce).success) return null;
  if (!z.iso.datetime().safeParse(issued).success) return null;
  return { domain, nonce, issued };
}
