/** One slot of getRecentPrioritizationFees: the lowest fee (micro-lamports per CU) that landed. */
export interface SlotFee {
  slot: bigint;
  prioritizationFee: bigint;
}

/** Accounts' p75 must be this many times the network's... */
export const CONTENTION_RATIO = 3n;
/** ...and at least this many micro-lamports per CU, to count as contended. */
export const CONTENTION_FLOOR = 10_000n;

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

/** Compares the write-locked accounts' recent p75 with the whole network's. */
export function detectContention(
  accounts: readonly SlotFee[],
  global: readonly SlotFee[],
): { accountsP75: bigint; globalP75: bigint; contended: boolean } {
  const a = paid(accounts);
  const g = paid(global);
  const accountsP75 = a.length > 0 ? percentile(a, 75) : 0n;
  const globalP75 = g.length > 0 ? percentile(g, 75) : 0n;
  const contended = accountsP75 >= CONTENTION_FLOOR && accountsP75 >= CONTENTION_RATIO * globalP75;
  return { accountsP75, globalP75, contended };
}
