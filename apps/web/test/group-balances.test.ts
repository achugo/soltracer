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

  it("folds a created ATA's rent into its owner's group", () => {
    // PAYER funds a new USDC ATA (rent 2,039,280) that receives 1 USDC.
    const groups = groupBalances(
      {
        sol: [
          sol(PAYER, "-2044280"),
          { address: ATA_A, pre: "0", post: "2039280", delta: "2039280" },
        ],
        tokens: [{ ...token(ATA_A, OTHER, USDC, "1000000"), pre: "0", post: "1000000" }],
      },
      PAYER,
    );
    expect(groups.map((g) => g.owner)).toEqual([PAYER, OTHER]);
    expect(groups.some((g) => g.owner === ATA_A)).toBe(false);
    expect(groups[1]).toMatchObject({
      sol: null,
      tokenAccountSol: [{ account: ATA_A, sol: { delta: "2039280" } }],
      tokens: [{ account: ATA_A, delta: "1000000" }],
    });
  });

  it("folds a closed WSOL account's lamports into its owner's group", () => {
    // PAYER unwraps 0.5 SOL: the WSOL account's rent plus wrapped lamports return to PAYER.
    const groups = groupBalances(
      {
        sol: [
          { address: ATA_B, pre: "502039280", post: "0", delta: "-502039280" },
          sol(PAYER, "502034280"),
        ],
        tokens: [{ ...token(ATA_B, PAYER, WSOL, "-500000000"), decimals: 9, pre: "500000000", post: "0" }],
      },
      PAYER,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      owner: PAYER,
      isFeePayer: true,
      sol: { delta: "502034280" },
      tokenAccountSol: [{ account: ATA_B, sol: { delta: "-502039280" } }],
      tokens: [{ account: ATA_B, mint: WSOL }],
    });
  });

  it("keeps a SOL row in its own group when no token row names it", () => {
    const groups = groupBalances({ sol: [sol(ATA_A, "2039280")], tokens: [] }, null);
    expect(groups).toEqual([{ owner: ATA_A, isFeePayer: false, sol: expect.anything(), tokenAccountSol: [], tokens: [] }]);
  });

  it("marks no fee payer when it has no balance rows", () => {
    const groups = groupBalances({ sol: [sol(OTHER, "1")], tokens: [] }, PAYER);
    expect(groups.every((g) => !g.isFeePayer)).toBe(true);
  });
});
