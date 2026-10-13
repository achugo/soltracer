import { z } from "zod";
import { pubkeySchema } from "./solana.ts";

/** Largest serialized transaction the network accepts. */
export const MAX_TX_BYTES = 1232;
/** Per-transaction compute unit ceiling. */
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
/** Default limit per non-ComputeBudget instruction when none is set (per the build prompt). */
export const DEFAULT_CU_PER_INSTRUCTION = 200_000;

/** u64 values travel as decimal strings: they can exceed Number.MAX_SAFE_INTEGER. */
const u64 = z.string().regex(/^\d{1,20}$/, "Must be a non-negative integer string");
// The difference of two u64 values still fits in 20 digits.
const signedAmount = z.string().regex(/^-?\d{1,20}$/, "Must be an integer string");

export const simulateRequestSchema = z.strictObject({
  tx: z.string().trim().min(1, "Paste a transaction").max(2000, "Too long to be a transaction"),
});

export const accountSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("static") }),
  z.object({ kind: z.literal("lookup"), table: pubkeySchema, index: z.number().int().min(0).max(255) }),
]);

export const accountRefSchema = z.object({
  address: pubkeySchema,
  writable: z.boolean(),
  signer: z.boolean(),
  source: accountSourceSchema,
});

export const computeBudgetSchema = z.object({
  limit: z.number().int().min(0).max(MAX_COMPUTE_UNIT_LIMIT),
  limitSource: z.enum(["explicit", "default"]),
  defaultLimit: z.number().int().min(0).max(MAX_COMPUTE_UNIT_LIMIT),
  priceMicroLamports: u64,
});

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

export const feeSchema = z.object({
  baseLamports: u64,
  priorityLamports: u64,
  totalLamports: u64,
});

export const solBalanceSchema = z.object({
  address: pubkeySchema,
  pre: u64,
  post: u64,
  delta: signedAmount,
});

export const tokenBalanceSchema = z.object({
  account: pubkeySchema,
  owner: pubkeySchema,
  mint: pubkeySchema,
  program: z.enum(["token", "token-2022"]),
  decimals: z.number().int().min(0).max(255),
  pre: u64,
  post: u64,
  delta: signedAmount,
});

export const simulationStatusSchema = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true) }),
  z.object({ success: z.literal(false), error: txErrorSchema }),
]);

export const simulationResultSchema = z.object({
  ok: z.literal(true),
  encoding: z.enum(["base64", "base58"]),
  version: z.union([z.literal("legacy"), z.literal(0)]),
  /** True when any signature slot is non-zero; rewriting would invalidate it. */
  signed: z.boolean(),
  accounts: z.array(accountRefSchema),
  computeBudget: computeBudgetSchema,
  unitsConsumed: z.number().int().min(0),
  status: simulationStatusSchema,
  fee: feeSchema,
  balances: z.object({ sol: z.array(solBalanceSchema), tokens: z.array(tokenBalanceSchema) }),
  logs: z.array(z.string()),
  slot: z.number().int().min(0),
  /** Helius credits this simulation spent. */
  credits: z.number().int().min(0),
});

export type SimulateRequest = z.infer<typeof simulateRequestSchema>;
export type AccountRef = z.infer<typeof accountRefSchema>;
export type ComputeBudget = z.infer<typeof computeBudgetSchema>;
export type TxError = z.infer<typeof txErrorSchema>;
export type Fee = z.infer<typeof feeSchema>;
export type SolBalance = z.infer<typeof solBalanceSchema>;
export type TokenBalance = z.infer<typeof tokenBalanceSchema>;
export type SimulationResult = z.infer<typeof simulationResultSchema>;

/** Formats an integer amount string with `decimals` places, trimming trailing zeros. */
export function formatUnits(raw: string, decimals: number): string {
  if (!/^-?\d+$/.test(raw)) throw new Error(`Not an integer amount: ${raw}`);
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error(`Invalid decimals: ${decimals}`);
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  const value = fraction ? `${whole}.${fraction}` : whole;
  return negative && value !== "0" ? `-${value}` : value;
}
