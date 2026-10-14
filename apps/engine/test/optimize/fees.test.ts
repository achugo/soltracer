import { describe, expect, it } from "vitest";
import { CONTENTION_MIN_P75, CONTENTION_MIN_PAID_SHARE, detectContention, feePresets, percentile } from "../../src/optimize/fees.ts";

const series = (...fees: number[]) => fees.map((f, i) => ({ slot: BigInt(1000 + i), prioritizationFee: BigInt(f) }));

describe("percentile (nearest rank)", () => {
  it("picks the value at ceil(p x n) in sorted order", () => {
    const values = [10n, 20n, 30n, 40n, 50n, 60n, 70n, 80n, 90n, 100n];
    expect(percentile(values, 50)).toBe(50n);
    expect(percentile(values, 75)).toBe(80n);
    expect(percentile(values, 90)).toBe(90n);
    expect(percentile([7n], 90)).toBe(7n);
  });

  it("does not depend on input order and handles values beyond 2^53", () => {
    const big = 2n ** 63n;
    expect(percentile([big, 1n, 3n, 2n], 75)).toBe(3n);
    expect(percentile([big, 1n, 3n, 2n], 100)).toBe(big);
  });

  it("throws on an empty list", () => {
    expect(() => percentile([], 50)).toThrow();
  });
});

describe("feePresets", () => {
  it("uses only slots that paid a fee", () => {
    const presets = feePresets(series(0, 0, 0, 100, 200, 300, 400, 0));
    expect(presets).toEqual({ p50: 200n, p75: 300n, p90: 400n });
  });

  it("returns null when no recent slot paid a fee", () => {
    expect(feePresets(series(0, 0, 0))).toBeNull();
    expect(feePresets([])).toBeNull();
  });
});

describe("detectContention", () => {
  it("flags accounts that paid in nearly every recent slot at a high p75", () => {
    const busy = series(...Array.from({ length: 20 }, (_, i) => 100_000 + i * 10_000));
    expect(detectContention(busy)).toEqual({ accountsP75: 240_000n, paidSlotShare: 1, contended: true });
  });

  it("does not flag cheap accounts even when they are busy", () => {
    const out = detectContention(series(...Array.from({ length: 20 }, () => 17_806)));
    expect(out).toMatchObject({ paidSlotShare: 1, contended: false });
  });

  it("does not flag expensive accounts that were rarely touched", () => {
    const rare = series(...Array.from({ length: 20 }, (_, i) => (i < 5 ? 500_000 : 0)));
    expect(detectContention(rare)).toEqual({ accountsP75: 500_000n, paidSlotShare: 0.25, contended: false });
  });

  it("handles an empty or all-zero series", () => {
    expect(detectContention([])).toEqual({ accountsP75: 0n, paidSlotShare: 0, contended: false });
    expect(detectContention(series(0, 0))).toEqual({ accountsP75: 0n, paidSlotShare: 0, contended: false });
  });

  it("uses the agreed thresholds", () => {
    expect(CONTENTION_MIN_PAID_SHARE).toBe(0.9);
    expect(CONTENTION_MIN_P75).toBe(100_000n);
  });
});
