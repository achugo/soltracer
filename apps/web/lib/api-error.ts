import type { ErrorResponse } from "@soltracer/shared/errors";
import { txErrorSchema, type TxError } from "@soltracer/shared/simulation";
import { z } from "zod";

/** Which request failed; it only changes the fallback title. */
export type ApiAction = "simulate" | "optimize" | "status";

const ACTION_TITLE: Record<ApiAction, string> = {
  simulate: "Simulation failed",
  optimize: "Optimization failed",
  status: "Status check failed",
};

export interface ApiErrorView {
  title: string;
  /** Engine/server message, shown verbatim. */
  message: string;
  /** What the user can do next, if anything. */
  hint: string | null;
  /** TX_DECODE_FAILED: each encoding the engine tried and why it failed. */
  tried: { encoding: string; reason: string }[];
  retryable: boolean;
  signIn: boolean;
  /** OPTIMIZE_NOT_FIXABLE: the decoded error that fees and limits cannot fix, when the engine sent one. */
  txError: TxError | null;
}

const triedSchema = z.object({
  tried: z.array(z.object({ encoding: z.string(), reason: z.string() })),
});
const tooLargeSchema = z.object({
  size: z.number(),
  limit: z.number(),
  version: z.union([z.literal("legacy"), z.number()]).optional(),
});

const notFixableSchema = z.object({ error: txErrorSchema });

const versionLabel = (v: "legacy" | number) => (v === "legacy" ? "legacy" : `v${v}`);

/** Maps an API error to user-facing copy. Unknown detail shapes are ignored, never trusted. */
export function describeApiError(err: ErrorResponse, action: ApiAction = "simulate"): ApiErrorView {
  const base: ApiErrorView = {
    title: ACTION_TITLE[action],
    message: err.message,
    hint: null,
    tried: [],
    retryable: false,
    signIn: false,
    txError: null,
  };
  switch (err.code) {
    case "TX_DECODE_FAILED": {
      const details = triedSchema.safeParse(err.details);
      return {
        ...base,
        title: "Could not decode the transaction",
        hint: "Paste a serialized transaction as base64 or base58.",
        tried: details.success ? details.data.tried : [],
      };
    }
    case "TX_TOO_LARGE": {
      const d = tooLargeSchema.safeParse(err.details);
      const hint = d.success
        ? `It is ${d.data.size.toLocaleString("en-US")} bytes; the limit${d.data.version === undefined ? "" : ` for ${versionLabel(d.data.version)}`} is ${d.data.limit.toLocaleString("en-US")} bytes.`
        : null;
      return { ...base, title: "Transaction is too large", hint };
    }
    case "OPTIMIZE_NOT_FIXABLE": {
      const d = notFixableSchema.safeParse(err.details);
      return {
        ...base,
        title: "Fees and limits can't fix this",
        hint: "Fix the cause shown below, then simulate again.",
        txError: d.success ? d.data.error : null,
      };
    }
    case "VALIDATION_ERROR":
      return { ...base, title: "Invalid input", hint: "Check the pasted transaction and any overrides, then try again." };
    case "LOCAL_LOAD_FAILED":
      return {
        ...base,
        title: "Local run unavailable",
        hint: "Couldn't load mainnet state locally, so overrides can't be applied. Remove the overrides to fall back to RPC.",
        retryable: true,
      };
    case "RPC_RATE_LIMITED":
      return { ...base, title: "Rate limited", hint: "The RPC rate limit was hit. Wait a few seconds, then retry.", retryable: true };
    case "RPC_ERROR":
      return { ...base, title: "RPC error", hint: "The RPC node returned an error. Retrying may help.", retryable: true };
    case "ENGINE_UNAVAILABLE":
      return { ...base, title: "Engine unavailable", hint: "Make sure the engine is running, then retry.", retryable: true };
    case "NOT_ALLOWLISTED":
      return { ...base, title: "Wallet not allowlisted", hint: "Only wallets in ALLOWLIST can use the engine." };
    case "UNAUTHORIZED":
      return { ...base, title: "Signed out", hint: "Your session has ended. Sign in again.", signIn: true };
    default:
      return { ...base, hint: err.code === "INTERNAL" ? "Something went wrong on the server. Retrying may help." : null, retryable: err.code === "INTERNAL" };
  }
}
