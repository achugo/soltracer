import { z } from "zod";
import { pubkeySchema } from "./solana.ts";

/** u64 values travel as decimal strings: they can exceed Number.MAX_SAFE_INTEGER. */
export const u64Schema = z.string().regex(/^\d{1,20}$/, "Must be a non-negative integer string");
/** The difference of two u64 values still fits in 20 digits. */
export const signedAmountSchema = z.string().regex(/^-?\d{1,20}$/, "Must be an integer string");

export const txErrorSchema = z.object({
  /** Top-level instruction that failed, when the error names one. */
  instructionIndex: z.number().int().min(0).nullable(),
  /** Program of that top-level instruction. */
  programId: pubkeySchema.nullable(),
  /** Program that actually raised the error, from the logs (may be a CPI callee). */
  failingProgramId: pubkeySchema.nullable(),
  code: z.number().int().nullable(),
  name: z.string().nullable(),
  message: z.string(),
  source: z.enum(["idl", "builtin", "raw"]),
  raw: z.unknown(),
});
