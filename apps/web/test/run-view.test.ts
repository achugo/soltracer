import { describe, expect, it } from "vitest";
import { instructionCuView, summarizeOverride } from "../lib/run-view.ts";
import { ATA_A, PAYER, SYSTEM, TOKEN_PROGRAM, USDC } from "./fixtures-simulation.ts";

const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const CB = "ComputeBudget111111111111111111111111111111";

describe("instructionCuView", () => {
  it("sorts by index and scales bars to the transaction total", () => {
    const view = instructionCuView(
      [
        { index: 2, programId: JUP, unitsConsumed: 60_000 },
        { index: 0, programId: CB, unitsConsumed: null },
        { index: 1, programId: TOKEN_PROGRAM, unitsConsumed: 20_000 },
      ],
      100_000,
    );
    expect(view.total).toBe(100_000);
    expect(view.unattributed).toBe(20_000);
    expect(view.rows).toEqual([
      { index: 0, programId: CB, units: null, percent: 0 },
      { index: 1, programId: TOKEN_PROGRAM, units: 20_000, percent: 20 },
      { index: 2, programId: JUP, units: 60_000, percent: 60 },
    ]);
  });

  it("uses the reported sum as the scale when it exceeds the total", () => {
    const view = instructionCuView(
      [
        { index: 0, programId: JUP, unitsConsumed: 300 },
        { index: 1, programId: TOKEN_PROGRAM, unitsConsumed: 100 },
      ],
      200,
    );
    expect(view.total).toBe(400);
    expect(view.unattributed).toBe(0);
    expect(view.rows.map((r) => r.percent)).toEqual([75, 25]);
  });

  it("handles zero units and an empty list", () => {
    expect(instructionCuView([{ index: 0, programId: SYSTEM, unitsConsumed: 0 }], 0).rows[0]?.percent).toBe(0);
    expect(instructionCuView([], 150)).toEqual({ rows: [], total: 150, unattributed: 150 });
  });
});

describe("summarizeOverride", () => {
  const tokens = [
    { account: ATA_A, owner: PAYER, mint: USDC, program: "token" as const, decimals: 6, pre: "0", post: "0", delta: "0" },
  ];

  it("shows SOL and lamports", () => {
    expect(summarizeOverride({ kind: "sol", address: PAYER, lamports: "1500000000" }, [])).toEqual({
      kind: "SOL",
      target: PAYER,
      mint: null,
      value: "1.5 SOL (1,500,000,000 lamports)",
      dataOwner: null,
    });
  });

  it("formats token amounts with known decimals, raw otherwise", () => {
    expect(summarizeOverride({ kind: "token", owner: PAYER, mint: USDC, amount: "2500000" }, tokens).value).toBe(
      "2.5 (2,500,000 raw units)",
    );
    expect(summarizeOverride({ kind: "token", owner: PAYER, mint: USDC, amount: "2500000" }, []).value).toBe(
      "2,500,000 raw units",
    );
  });

  it("shows data size and owner", () => {
    expect(summarizeOverride({ kind: "data", address: PAYER, dataBase64: "AQIDBA==", owner: TOKEN_PROGRAM }, [])).toEqual({
      kind: "Data",
      target: PAYER,
      mint: null,
      value: "4 bytes",
      dataOwner: TOKEN_PROGRAM,
    });
    expect(summarizeOverride({ kind: "data", address: PAYER, dataBase64: "" }, []).value).toBe("0 bytes");
  });
});
