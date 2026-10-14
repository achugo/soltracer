import type { FeePreset, OptimizeResult, OptimizeWarning } from "@soltracer/shared/optimize";
import type { AccountRef, ComputeBudget } from "@soltracer/shared/simulation";
import { formatDelta, groupDigits, LAMPORTS_DECIMALS, lamportsToSol, type SignedAmount } from "./format.ts";

export const FEE_PRESETS: readonly FeePreset[] = ["p50", "p75", "p90"];

export const PRESET_LABEL: Record<FeePreset, string> = {
  p50: "Median (p50)",
  p75: "Fast (p75)",
  p90: "Fastest (p90)",
};

export interface FeeSide {
  cuUsed: number;
  cuLimit: number;
  limitSource: ComputeBudget["limitSource"];
  priorityLamports: string;
  totalLamports: string;
}

export interface FeeComparison {
  before: FeeSide;
  after: FeeSide;
  /** after − before, in SOL with an explicit sign. */
  totalDelta: SignedAmount;
  totalDeltaLamports: string;
  /** False when `selected` is not the preset the engine simulated. */
  afterSimulated: boolean;
}

/**
 * Before is the transaction as pasted. After uses the selected preset's fees; its CU usage is from the
 * engine's simulation of the chosen preset, which has the same instructions and limit as the others.
 */
export function compareFees(result: OptimizeResult, selected: FeePreset): FeeComparison {
  const preset = result.presets[selected];
  const before: FeeSide = {
    cuUsed: result.before.unitsConsumed,
    cuLimit: result.before.computeBudget.limit,
    limitSource: result.before.computeBudget.limitSource,
    priorityLamports: result.before.fee.priorityLamports,
    totalLamports: result.before.fee.totalLamports,
  };
  const after: FeeSide = {
    cuUsed: result.after.unitsConsumed,
    cuLimit: result.computeUnitLimit,
    limitSource: result.after.computeBudget.limitSource,
    priorityLamports: preset.priorityFeeLamports,
    totalLamports: preset.totalFeeLamports,
  };
  const delta = (BigInt(after.totalLamports) - BigInt(before.totalLamports)).toString();
  return {
    before,
    after,
    totalDelta: formatDelta(delta, LAMPORTS_DECIMALS),
    totalDeltaLamports: delta,
    afterSimulated: selected === result.chosen,
  };
}

export interface PresetOption {
  preset: FeePreset;
  label: string;
  priceMicroLamports: string;
  totalSol: string;
  totalLamports: string;
  selected: boolean;
  /** Only `result.chosen` was simulated after the rewrite. */
  simulated: boolean;
}

export function presetOptions(result: OptimizeResult, selected: FeePreset): PresetOption[] {
  return FEE_PRESETS.map((preset) => {
    const p = result.presets[preset];
    return {
      preset,
      label: PRESET_LABEL[preset],
      priceMicroLamports: p.priceMicroLamports,
      totalSol: lamportsToSol(p.totalFeeLamports),
      totalLamports: p.totalFeeLamports,
      selected: preset === selected,
      simulated: preset === result.chosen,
    };
  });
}

export type FeePayerCheck =
  | { kind: "match"; feePayer: string }
  | { kind: "mismatch"; feePayer: string; wallet: string }
  | { kind: "no-wallet"; feePayer: string | null }
  | { kind: "unknown" };

/** The wallet can only sign the rewritten transaction if it is the fee payer (account 0). */
export function checkFeePayer(result: OptimizeResult, wallet: string | null): FeePayerCheck {
  // The chosen preset's accounts; the engine guarantees every preset keeps the same payer and signers.
  const feePayer = result.after.accounts[0]?.address ?? null;
  if (wallet === null) return { kind: "no-wallet", feePayer };
  if (feePayer === null) return { kind: "unknown" };
  return feePayer === wallet ? { kind: "match", feePayer } : { kind: "mismatch", feePayer, wallet };
}

/**
 * Signers other than the wallet. The rewrite clears every signature, so a wallet can only add its own:
 * any other required signer means the transaction can never land when sent from here.
 */
export function otherRequiredSigners(accounts: readonly AccountRef[], wallet: string): string[] {
  return [...new Set(accounts.filter((a) => a.signer && a.address !== wallet).map((a) => a.address))];
}

export type SendBlock =
  | { kind: "fee-payer"; message: string }
  | { kind: "other-signers"; signers: string[]; message: string };

/** Why `wallet` cannot sign and send the rewritten transaction, or null when it can. */
export function sendBlock(result: OptimizeResult, wallet: string): SendBlock | null {
  const payer = checkFeePayer(result, wallet);
  if (payer.kind !== "match") {
    return { kind: "fee-payer", message: "The connected wallet is not the fee payer." };
  }
  // The chosen preset's accounts; the engine guarantees every preset keeps the same payer and signers.
  const signers = otherRequiredSigners(result.after.accounts, wallet);
  if (signers.length > 0) {
    return {
      kind: "other-signers",
      signers,
      message:
        "This transaction needs more signers. They must sign too, and the rewrite clears every signature, so it can't be sent from SolTracer.",
    };
  }
  return null;
}

export type WarningCode = OptimizeWarning["code"] | "FEE_PAYER_MISMATCH";

export interface WarningView {
  code: WarningCode;
  /** "danger" blocks or breaks sending; "caution" needs attention. */
  tone: "danger" | "caution";
  title: string;
  message: string;
  /** Extra facts shown in font-mono, e.g. contention numbers. */
  facts: { label: string; value: string }[];
}

const WARNING_TITLE: Record<OptimizeWarning["code"], string> = {
  SIGNED: "Rewriting invalidates existing signatures",
  CONTENTION: "Write-locked accounts are contended",
  DURABLE_NONCE: "Durable nonce transaction",
  NO_FEE_DATA: "No recent fee data",
};

/** Share of slots that paid, as a whole-number percentage (one decimal below 10%). */
export function formatShare(share: number): string {
  const pct = share * 100;
  return `${pct > 0 && pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** Engine warnings plus the UI's own fee-payer check, most severe first. */
export function describeWarnings(result: OptimizeResult, feePayer: FeePayerCheck): WarningView[] {
  const views: WarningView[] = [];
  if (feePayer.kind === "mismatch") {
    views.push({
      code: "FEE_PAYER_MISMATCH",
      tone: "danger",
      title: "Connected wallet is not the fee payer",
      message:
        "A wallet can only sign and send this transaction if it is the fee payer. Connect the fee payer's wallet to send it.",
      facts: [
        { label: "Fee payer", value: feePayer.feePayer },
        { label: "Connected", value: feePayer.wallet },
      ],
    });
  }
  for (const w of result.warnings) {
    const facts =
      w.code === "CONTENTION" && result.contention
        ? [
            { label: "Accounts p75", value: `${groupDigits(result.contention.accountsP75)} µ-lamports/CU` },
            { label: "Slots that paid", value: formatShare(result.contention.paidSlotShare) },
          ]
        : [];
    views.push({
      code: w.code,
      tone: w.code === "SIGNED" ? "danger" : "caution",
      title: WARNING_TITLE[w.code],
      message: w.message,
      facts,
    });
  }
  const rank = (v: WarningView) => (v.tone === "danger" ? 0 : 1);
  return views.sort((a, b) => rank(a) - rank(b));
}
