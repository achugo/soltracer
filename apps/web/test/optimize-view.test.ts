import { describe, expect, it } from "vitest";
import { checkFeePayer, compareFees, describeWarnings, formatShare, presetOptions } from "../lib/optimize-view.ts";
import { OTHER, PAYER } from "./fixtures-simulation.ts";
import { optimizeResult } from "./fixtures-optimize.ts";

describe("compareFees", () => {
  it("compares the pasted transaction with the chosen preset", () => {
    const c = compareFees(optimizeResult(), "p75");
    expect(c.before).toEqual({ cuUsed: 180_000, cuLimit: 200_000, limitSource: "default", priorityLamports: "0", totalLamports: "5000" });
    expect(c.after).toEqual({ cuUsed: 180_300, cuLimit: 207_345, limitSource: "explicit", priorityLamports: "4147", totalLamports: "9147" });
    expect(c.totalDeltaLamports).toBe("4147");
    expect(c.totalDelta).toEqual({ direction: "up", text: "+0.000004147" });
    expect(c.afterSimulated).toBe(true);
  });

  it("uses another preset's fees without claiming it was simulated", () => {
    const c = compareFees(optimizeResult(), "p90");
    expect(c.after.totalLamports).toBe("316018");
    expect(c.after.priorityLamports).toBe("311018");
    expect(c.after.cuLimit).toBe(207_345);
    expect(c.afterSimulated).toBe(false);
  });

  it("reports a lower fee with a minus sign", () => {
    const r = optimizeResult();
    const before = { ...r.before, fee: { baseLamports: "5000", priorityLamports: "50000", totalLamports: "55000" } };
    const c = compareFees({ ...r, before }, "p50");
    expect(c.totalDeltaLamports).toBe("-47926");
    expect(c.totalDelta).toEqual({ direction: "down", text: "−0.000047926" });
  });

  it("handles u64-sized fees without precision loss", () => {
    const r = optimizeResult();
    const big = "18446744073709551615";
    const presets = { ...r.presets, p90: { ...r.presets.p90, totalFeeLamports: big } };
    expect(compareFees({ ...r, presets }, "p90").totalDeltaLamports).toBe("18446744073709546615");
  });
});

describe("presetOptions", () => {
  it("lists p50, p75, p90 with price, total and simulated flag", () => {
    const opts = presetOptions(optimizeResult(), "p90");
    expect(opts.map((o) => o.preset)).toEqual(["p50", "p75", "p90"]);
    expect(opts.map((o) => o.selected)).toEqual([false, false, true]);
    expect(opts.map((o) => o.simulated)).toEqual([false, true, false]);
    expect(opts[2]).toMatchObject({ priceMicroLamports: "1500000", totalSol: "0.000316018", totalLamports: "316018" });
  });

  it("marks whichever preset the engine chose as simulated", () => {
    const opts = presetOptions(optimizeResult({ chosen: "p50" }), "p50");
    expect(opts.find((o) => o.simulated)?.preset).toBe("p50");
  });
});

describe("checkFeePayer", () => {
  it("matches when the wallet is account 0", () => {
    expect(checkFeePayer(optimizeResult(), PAYER)).toEqual({ kind: "match", feePayer: PAYER });
  });

  it("flags a different wallet", () => {
    expect(checkFeePayer(optimizeResult(), OTHER)).toEqual({ kind: "mismatch", feePayer: PAYER, wallet: OTHER });
  });

  it("reports no wallet and no accounts", () => {
    expect(checkFeePayer(optimizeResult(), null)).toEqual({ kind: "no-wallet", feePayer: PAYER });
    const r = optimizeResult();
    expect(checkFeePayer({ ...r, before: { ...r.before, accounts: [] } }, PAYER)).toEqual({ kind: "unknown" });
  });
});

describe("describeWarnings", () => {
  it("is empty with no warnings and a matching wallet", () => {
    expect(describeWarnings(optimizeResult(), { kind: "match", feePayer: PAYER })).toEqual([]);
  });

  it("puts SIGNED and FEE_PAYER_MISMATCH first as dangers", () => {
    const r = optimizeResult({
      warnings: [
        { code: "NO_FEE_DATA", message: "no data" },
        { code: "SIGNED", message: "signed" },
        { code: "DURABLE_NONCE", message: "nonce" },
      ],
    });
    const views = describeWarnings(r, { kind: "mismatch", feePayer: PAYER, wallet: OTHER });
    expect(views.map((v) => [v.code, v.tone])).toEqual([
      ["FEE_PAYER_MISMATCH", "danger"],
      ["SIGNED", "danger"],
      ["NO_FEE_DATA", "caution"],
      ["DURABLE_NONCE", "caution"],
    ]);
    expect(views[1]?.title).toBe("Rewriting invalidates existing signatures");
    expect(views[0]?.message).toMatch(/only sign .* if it is the fee payer/);
    expect(views[0]?.facts).toEqual([
      { label: "Fee payer", value: PAYER },
      { label: "Connected", value: OTHER },
    ]);
  });

  it("shows contention p75 and paid-slot share", () => {
    const r = optimizeResult({
      contention: { accountsP75: "2500000", paidSlotShare: 0.825 },
      warnings: [{ code: "CONTENTION", message: "busy" }],
    });
    const [view] = describeWarnings(r, { kind: "no-wallet", feePayer: PAYER });
    expect(view?.facts).toEqual([
      { label: "Accounts p75", value: "2,500,000 µ-lamports/CU" },
      { label: "Slots that paid", value: "83%" },
    ]);
  });
});

describe("formatShare", () => {
  it.each([
    [0, "0%"],
    [0.042, "4.2%"],
    [0.5, "50%"],
    [1, "100%"],
  ])("%d -> %s", (share, text) => {
    expect(formatShare(share)).toBe(text);
  });
});
