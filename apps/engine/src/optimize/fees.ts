/** One slot of getRecentPrioritizationFees: the lowest fee (micro-lamports per CU) that landed. */
export interface SlotFee {
  slot: bigint;
  prioritizationFee: bigint;
}

/**
 * Contended = the write-locked accounts were busy (a paid fee in at least this share of recent
 * slots) and expensive (p75 at least this many micro-lamports per CU). There is no usable network
 * baseline: getRecentPrioritizationFees without accounts reports each slot's minimum, which is 0.
 */
export const CONTENTION_MIN_PAID_SHARE = 0.9;
export const CONTENTION_MIN_P75 = 100_000n;

/** Nearest-rank percentile: the value at position ceil(p/100 x n) in sorted order. */
export function percentile(values: readonly bigint[], p: number): bigint {
  if (values.length === 0) throw new Error("percentile of an empty list");
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] as bigint; // rank is clamped to 1..length, so the index exists
}

/** Slots where nothing paid a fee say nothing about the going rate; leave them out. */
function paid(series: readonly SlotFee[]): bigint[] {
  return series.map((s) => s.prioritizationFee).filter((f) => f > 0n);
}

/** p50/p75/p90 of recent paid fees for the write-locked accounts; null if none paid. */
export function feePresets(series: readonly SlotFee[]): { p50: bigint; p75: bigint; p90: bigint } | null {
  const fees = paid(series);
  if (fees.length === 0) return null;
  return { p50: percentile(fees, 50), p75: percentile(fees, 75), p90: percentile(fees, 90) };
}

/** Whether the write-locked accounts are contended, from their recent per-slot fees. */
export function detectContention(accounts: readonly SlotFee[]): {
  accountsP75: bigint;
  paidSlotShare: number;
  contended: boolean;
} {
  const fees = paid(accounts);
  const accountsP75 = fees.length > 0 ? percentile(fees, 75) : 0n;
  const paidSlotShare = accounts.length > 0 ? fees.length / accounts.length : 0;
  const contended = paidSlotShare >= CONTENTION_MIN_PAID_SHARE && accountsP75 >= CONTENTION_MIN_P75;
  return { accountsP75, paidSlotShare, contended };
}
