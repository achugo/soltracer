import { describe, expect, it } from "vitest";
import { CONTENTION_FLOOR, CONTENTION_RATIO, detectContention, feePresets, percentile } from "../../src/optimize/fees.ts";

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
  it("flags accounts whose p75 is at least the ratio above the network and over the floor", () => {
    const out = detectContention(series(0, 50_000, 60_000, 70_000), series(5_000, 10_000, 15_000, 20_000));
    expect(out).toEqual({ accountsP75: 70_000n, globalP75: 15_000n, contended: true });
  });

  it("does not flag when the gap is smaller than the ratio", () => {
    const out = detectContention(series(20_000, 30_000, 40_000), series(10_000, 15_000, 20_000));
    expect(out.contended).toBe(false);
  });

  it("does not flag tiny fees even when the ratio is large", () => {
    const out = detectContention(series(900, 1_000), series(1, 2));
    expect(out.contended).toBe(false);
    expect(CONTENTION_FLOOR).toBe(10_000n);
    expect(CONTENTION_RATIO).toBe(3n);
  });

  it("treats a network with no paid slots as zero and flags only above the floor", () => {
    expect(detectContention(series(20_000), series(0, 0))).toEqual({ accountsP75: 20_000n, globalP75: 0n, contended: true });
    expect(detectContention(series(0), series(0))).toEqual({ accountsP75: 0n, globalP75: 0n, contended: false });
  });
});
