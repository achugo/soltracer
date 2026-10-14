import { z } from "zod";
import { MAX_COMPUTE_UNIT_LIMIT, simulateRequestSchema, simulationResultSchema, u64Schema } from "./simulation.ts";
import { blockhashSchema, signatureSchema } from "./solana.ts";

export const feePresetSchema = z.enum(["p50", "p75", "p90"]);

export const optimizeRequestSchema = z.strictObject({
  tx: simulateRequestSchema.shape.tx,
  preset: feePresetSchema.default("p75"),
});

/** One unsigned, rewritten transaction per fee preset; switching presets needs no RPC call. */
export const presetResultSchema = z.object({
  priceMicroLamports: u64Schema,
  priorityFeeLamports: u64Schema,
  totalFeeLamports: u64Schema,
  /** Unsigned transaction, base64, ready for the wallet to sign and send. */
  tx: z.string().min(1).max(6000),
});

export const optimizeWarningSchema = z.object({
  code: z.enum(["SIGNED", "CONTENTION", "DURABLE_NONCE", "NO_FEE_DATA"]),
  message: z.string(),
});

export const optimizeResultSchema = z.object({
  ok: z.literal(true),
  /** The original transaction, simulated as pasted. */
  before: simulationResultSchema,
  /** The chosen preset's rewritten transaction, simulated. */
  after: simulationResultSchema,
  computeUnitLimit: z.number().int().min(0).max(MAX_COMPUTE_UNIT_LIMIT),
  presets: z.object({ p50: presetResultSchema, p75: presetResultSchema, p90: presetResultSchema }),
  chosen: feePresetSchema,
  blockhash: blockhashSchema,
  lastValidBlockHeight: u64Schema,
  /** Recent p75 fees (micro-lamports per CU) for the write-locked accounts vs. the whole network. */
  contention: z.object({ accountsP75: u64Schema, globalP75: u64Schema }).nullable(),
  warnings: z.array(optimizeWarningSchema),
  credits: z.number().int().min(0),
});

export const txStatusRequestSchema = z.strictObject({ signature: signatureSchema });

export const txStatusResultSchema = z.object({
  ok: z.literal(true),
  /** Null when the cluster has no recent record of the signature (not landed yet, or dropped). */
  status: z
    .object({
      confirmationStatus: z.enum(["processed", "confirmed", "finalized"]).nullable(),
      /** null when the transaction succeeded; the on-chain error otherwise. Always present. */
      err: z.unknown().refine((v) => v !== undefined, "err is required (null on success)"),
      slot: z.number().int().min(0),
    })
    .nullable(),
});

export type FeePreset = z.infer<typeof feePresetSchema>;
export type OptimizeRequest = z.infer<typeof optimizeRequestSchema>;
export type PresetResult = z.infer<typeof presetResultSchema>;
export type OptimizeWarning = z.infer<typeof optimizeWarningSchema>;
export type OptimizeResult = z.infer<typeof optimizeResultSchema>;
export type TxStatusRequest = z.infer<typeof txStatusRequestSchema>;
export type TxStatusResult = z.infer<typeof txStatusResultSchema>;
