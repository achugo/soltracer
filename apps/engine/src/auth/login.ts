import { randomBytes } from "node:crypto";
import {
  makeError,
  NONCE_TTL_MS,
  parseLoginMessage,
  type ErrorResponse,
  type NonceResponse,
  type EngineVerifyRequest,
  type VerifyResponse,
} from "@soltracer/shared";
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { NonceStore } from "./nonce-store.ts";

export async function issueNonce(store: NonceStore, now: Date): Promise<NonceResponse> {
  const nonce = bs58.encode(randomBytes(16));
  const expiresAt = new Date(now.getTime() + NONCE_TTL_MS);
  await store.create(nonce, now, expiresAt);
  return { ok: true, nonce, issuedAt: now.toISOString(), expiresAt: expiresAt.toISOString() };
}

export type LoginFailure = { status: 400 | 401 | 403; error: ErrorResponse };

/**
 * Checks the message shape, domain, signature and allowlist before spending the nonce,
 * so a forged or refused attempt cannot burn the real user's nonce.
 */
export async function verifyLogin(
  req: EngineVerifyRequest,
  deps: { store: NonceStore; allowlist: readonly string[]; now: Date },
): Promise<VerifyResponse | LoginFailure> {
  const parsed = parseLoginMessage(req.message);
  if (!parsed) {
    return { status: 400, error: makeError("BAD_MESSAGE", "The signed message is not a SolTracer login message.") };
  }

  if (parsed.domain !== req.domain) {
    return {
      status: 400,
      error: makeError("BAD_MESSAGE", "This message was signed for a different site.", {
        signedFor: parsed.domain,
        expected: req.domain,
      }),
    };
  }

  const signatureOk = nacl.sign.detached.verify(
    new TextEncoder().encode(req.message),
    bs58.decode(req.signature),
    bs58.decode(req.publicKey),
  );
  if (!signatureOk) {
    return { status: 401, error: makeError("BAD_SIGNATURE", "The signature does not match this wallet.") };
  }

  if (!deps.allowlist.includes(req.publicKey)) {
    return {
      status: 403,
      error: makeError("NOT_ALLOWLISTED", "This wallet is not on the allowlist. Only allowlisted wallets can sign in.", {
        publicKey: req.publicKey,
      }),
    };
  }

  const spent = await deps.store.consume(parsed.nonce, deps.now);
  switch (spent.status) {
    case "unknown":
      return { status: 401, error: makeError("NONCE_INVALID", "This sign-in request was not issued by SolTracer. Try again.") };
    case "used":
      return { status: 401, error: makeError("NONCE_USED", "This sign-in request was already used. Try again.") };
    case "expired":
      return { status: 401, error: makeError("NONCE_EXPIRED", "This sign-in request expired. Try again.") };
    case "ok":
      if (spent.issuedAt.toISOString() !== parsed.issued) {
        return { status: 400, error: makeError("BAD_MESSAGE", "The Issued time does not match this sign-in request.") };
      }
      return { ok: true, publicKey: req.publicKey };
  }
}
