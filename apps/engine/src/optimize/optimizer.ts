import { makeError, type ErrorResponse } from "@soltracer/shared/errors";
import {
  optimizeResultSchema,
  txStatusResultSchema,
  type TxStatusResult,
  type FeePreset,
  type OptimizeResult,
  type OptimizeWarning,
  type PresetResult,
} from "@soltracer/shared/optimize";
import { MAX_COMPUTE_UNIT_LIMIT, type SimulationResult } from "@soltracer/shared/simulation";
import { signature as toSignature, type Address } from "@solana/kit";
import type { SandboxCaches } from "../cache/types.ts";
import type { RpcSession } from "../rpc/client.ts";
import { jsonSafe } from "../decode/program-error.ts";
import { simulateWithRpc, type SimulatorLog } from "../sim/rpc-simulator.ts";
import { priorityFeeLamports } from "../tx/compute-budget.ts";
import { decodeTransactionInput } from "../tx/decode.ts";
import { detectContention, feePresets } from "./fees.ts";
import { addedBudgetCost, nonBudgetInstructions, rewriteTransaction } from "./rewrite.ts";

export type OptimizeOutcome = { ok: true; result: OptimizeResult } | { ok: false; status: number; error: ErrorResponse };

/** Headroom over measured usage, per the build prompt. */
export const CU_MARGIN_NUMERATOR = 115n;
const PRESETS: FeePreset[] = ["p50", "p75", "p90"];

/** True when a simulation failed only because it ran out of compute units. */
export function isOutOfCompute(result: SimulationResult): boolean {
  if (result.status.success) return false;
  return (
    result.status.error.name === "ComputationalBudgetExceeded" ||
    result.logs.some((l) => l.includes("exceeded CUs meter") || l.includes("Computational budget exceeded"))
  );
}

/** ceil(used x 1.15), capped at 1.4M and at least 1. */
export function limitFor(unitsConsumed: number): number {
  const withMargin = (BigInt(unitsConsumed) * CU_MARGIN_NUMERATOR + 99n) / 100n;
  return Math.max(1, Math.min(MAX_COMPUTE_UNIT_LIMIT, Number(withMargin)));
}

const notFixable = (message: string, details: unknown): OptimizeOutcome => ({
  ok: false,
  status: 422,
  error: makeError("OPTIMIZE_NOT_FIXABLE", message, details),
});

/**
 * Turns a transaction into one that should land: right-sized CU limit, a priority fee from recent
 * network data and a fresh blockhash. Returns unsigned transactions; never signs or sends.
 */
export async function optimizeWithRpc(
  input: { tx: string; preset: FeePreset },
  session: RpcSession,
  caches: SandboxCaches,
  log?: SimulatorLog,
): Promise<OptimizeOutcome> {
  const first = await simulateWithRpc(input.tx, session, caches, log);
  if (!first.ok) return first;
  const before = first.result;

  const decoded = decodeTransactionInput(input.tx);
  if (!decoded.ok) return { ok: false, status: 400, error: decoded.error };
  const tx = decoded.tx;
  const accounts = before.accounts;

  // Measure what the transaction really needs, including budget instructions the rewrite adds.
  let used = before.unitsConsumed + addedBudgetCost(tx, accounts);
  if (!before.status.success) {
    if (!isOutOfCompute(before)) {
      return notFixable(
        "This transaction fails for a reason fees and limits can't fix. See the error in the simulation.",
        { error: before.status.error },
      );
    }
    const probe = rewriteTransaction({
      tx,
      accounts,
      limit: MAX_COMPUTE_UNIT_LIMIT,
      priceMicroLamports: BigInt(before.computeBudget.priceMicroLamports ?? "0"),
      lifetime: { blockhash: tx.compiled.lifetimeToken, lastValidBlockHeight: 0n },
    });
    if (!probe.ok) return notFixable(probe.error.message, probe.error.details);
    const measured = await simulateWithRpc(probe.wireBase64, session, caches, log);
    if (!measured.ok) return measured;
    if (!measured.result.status.success) {
      return notFixable("This transaction still fails with the maximum compute limit.", { error: measured.result.status.error });
    }
    // The probe already contains the inserted budget instructions, so their cost is included.
    used = measured.result.unitsConsumed;
  }
  const limit = limitFor(used);

  // Recent fees for the accounts it write-locks (the RPC accepts up to 128).
  const locked = [...new Set(accounts.filter((a) => a.writable).map((a) => a.address as Address))].slice(0, 128);
  const accountFees = await session.rpc.getRecentPrioritizationFees(locked).send();
  const presetPrices = feePresets(accountFees);
  const contention = detectContention(accountFees);

  const latest = await session.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const lifetime = { blockhash: latest.value.blockhash, lastValidBlockHeight: latest.value.lastValidBlockHeight };

  const original = nonBudgetInstructions(tx, accounts);
  const baseFee = BigInt(before.fee.baseLamports);
  const presets = {} as Record<FeePreset, PresetResult>;
  let durableNonce = false;
  for (const preset of PRESETS) {
    const price = presetPrices ? presetPrices[preset] : 0n;
    const rewritten = rewriteTransaction({ tx, accounts, limit, priceMicroLamports: price, lifetime });
    if (!rewritten.ok) return notFixable(rewritten.error.message, rewritten.error.details);
    durableNonce = rewritten.durableNonce;

    const check = decodeTransactionInput(rewritten.wireBase64);
    if (!check.ok) throw new Error(`Rewritten transaction does not decode: ${check.error.message}`);
    if (JSON.stringify(nonBudgetInstructions(check.tx, accounts)) !== JSON.stringify(original)) {
      throw new Error("Rewrite changed a non-budget instruction");
    }
    const priority = priorityFeeLamports(limit, price);
    presets[preset] = {
      priceMicroLamports: price.toString(),
      priorityFeeLamports: priority.toString(),
      totalFeeLamports: (baseFee + priority).toString(),
      tx: rewritten.wireBase64,
    };
  }

  const verified = await simulateWithRpc(presets[input.preset].tx, session, caches, log);
  if (!verified.ok) return verified;
  if (!verified.result.status.success) {
    return notFixable("The rewritten transaction still fails in simulation.", { error: verified.result.status.error });
  }

  const warnings: OptimizeWarning[] = [];
  if (before.signed) {
    warnings.push({
      code: "SIGNED",
      message: "The pasted transaction was signed. Rewriting it invalidates those signatures; your wallet signs the new one.",
    });
  }
  if (contention.contended) {
    warnings.push({
      code: "CONTENTION",
      message: "Accounts this transaction writes to are in high demand: they paid priority fees in almost every recent slot, at high prices.",
    });
  }
  if (durableNonce) {
    warnings.push({ code: "DURABLE_NONCE", message: "This transaction uses a durable nonce, so its blockhash was kept." });
  }
  if (!presetPrices) {
    warnings.push({ code: "NO_FEE_DATA", message: "No recent paid fees for these accounts; presets are set to zero." });
  }

  const result: OptimizeResult = {
    ok: true,
    before,
    after: verified.result,
    computeUnitLimit: limit,
    presets,
    chosen: input.preset,
    blockhash: lifetime.blockhash,
    lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
    contention:
      accountFees.length > 0
        ? { accountsP75: contention.accountsP75.toString(), paidSlotShare: contention.paidSlotShare }
        : null,
    warnings,
    credits: session.credits(),
  };
  log?.info({ credits: result.credits, limit, chosen: input.preset }, "optimize done");
  return { ok: true, result: optimizeResultSchema.parse(result) };
}

/** Latest known status of a signature (no history search: 1 credit), validated with the shared schema. */
export async function signatureStatus(session: RpcSession, signature: string): Promise<TxStatusResult["status"]> {
  const { value } = await session.rpc
    .getSignatureStatuses([toSignature(signature)], { searchTransactionHistory: false })
    .send();
  const status = value[0];
  return txStatusResultSchema.shape.status.parse(
    status
      ? { confirmationStatus: status.confirmationStatus ?? null, err: jsonSafe(status.err ?? null), slot: Number(status.slot) }
      : null,
  );
}
