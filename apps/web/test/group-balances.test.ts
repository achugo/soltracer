import type { TokenBalance } from "@soltracer/shared/simulation";
import { describe, expect, it } from "vitest";
import { groupBalances } from "../lib/group-balances.ts";
import { ATA_A, ATA_B, OTHER, PAYER, THIRD, TOKEN_PROGRAM, USDC, WSOL } from "./fixtures-simulation.ts";

const sol = (address: string, delta: string) => ({ address, pre: "1000000000", post: String(1_000_000_000n + BigInt(delta)), delta });
const token = (account: string, owner: string, mint: string, delta: string): TokenBalance => ({
  account,
  owner,
  mint,
  program: "token",
  decimals: 6,
  pre: "5000000",
  post: String(5_000_000n + BigInt(delta)),
  delta,
});

describe("groupBalances", () => {
  it("returns nothing for no balances", () => {
    expect(groupBalances({ sol: [], tokens: [] }, PAYER)).toEqual([]);
  });

  it("puts token rows under their owner next to the owner's SOL row", () => {
    const groups = groupBalances(
      { sol: [sol(PAYER, "-5000")], tokens: [token(ATA_A, PAYER, USDC, "-1000000"), token(ATA_B, PAYER, WSOL, "2000")] },
      PAYER,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ owner: PAYER, isFeePayer: true, sol: { delta: "-5000" } });
    expect(groups[0]?.tokens.map((t) => t.account)).toEqual([ATA_A, ATA_B]);
  });

  it("puts the fee payer first even with a smaller SOL change", () => {
    const groups = groupBalances({ sol: [sol(OTHER, "900000000"), sol(PAYER, "-5000")], tokens: [] }, PAYER);
    expect(groups.map((g) => g.owner)).toEqual([PAYER, OTHER]);
  });

  it("orders other owners by largest absolute SOL change, negative or positive", () => {
    const groups = groupBalances(
      { sol: [sol(OTHER, "10"), sol(THIRD, "-500"), sol(TOKEN_PROGRAM, "200")], tokens: [] },
      null,
    );
    expect(groups.map((g) => g.owner)).toEqual([THIRD, TOKEN_PROGRAM, OTHER]);
  });

  it("compares u64-sized deltas exactly", () => {
    const groups = groupBalances(
      { sol: [sol(OTHER, "9007199254740993"), sol(THIRD, "9007199254740995")], tokens: [] },
      null,
    );
    expect(groups.map((g) => g.owner)).toEqual([THIRD, OTHER]);
  });

  it("keeps first-appearance order on ties and for token-only owners", () => {
    const groups = groupBalances(
      { sol: [sol(PAYER, "-5000")], tokens: [token(ATA_A, THIRD, USDC, "1"), token(ATA_B, OTHER, USDC, "-1")] },
      PAYER,
    );
    expect(groups.map((g) => g.owner)).toEqual([PAYER, THIRD, OTHER]);
    expect(groups[1]).toMatchObject({ sol: null, isFeePayer: false });
  });

  it("marks no fee payer when it has no balance rows", () => {
    const groups = groupBalances({ sol: [sol(OTHER, "1")], tokens: [] }, PAYER);
    expect(groups.every((g) => !g.isFeePayer)).toBe(true);
  });
});
