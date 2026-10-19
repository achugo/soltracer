import type { OptimizeResult } from "@soltracer/shared/optimize";
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { SimulationResult } from "@soltracer/shared/simulation";
import { isOutOfCompute, limitFor } from "../../src/optimize/optimizer.ts";
import { addedBudgetCost, nonBudgetInstructions } from "../../src/optimize/rewrite.ts";
import { priorityFeeLamports, readComputeBudget, tablesFrom } from "../../src/tx/compute-budget.ts";
import { decodeTransactionInput, type DecodedTransaction } from "../../src/tx/decode.ts";
import { resolveAccounts } from "../../src/tx/lookup-tables.ts";
import { replayOptimization } from "../helpers/replay.ts";

function decode(wire: string): DecodedTransaction {
  const res = decodeTransactionInput(wire);
  if (!res.ok) throw new Error(res.error.message);
  return res.tx;
}

async function optimize(name: string): Promise<{ result: OptimizeResult; input: string }> {
  const { outcome, unused, input } = await replayOptimization(name);
  if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
  expect(unused).toBe(0); // exactly the recorded calls were made
  return { result: outcome.result, input };
}

/** Acceptance: every preset's transaction keeps every non-budget instruction identical, and is unsigned and within size. */
function expectFaithfulRewrites({ result, input }: { result: OptimizeResult; input: string }) {
  const original = decode(input);
  const tables = new Map(Object.entries(tablesFrom(result.before.accounts)) as [Address, Address[]][]);
  const originalIxs = nonBudgetInstructions(original, result.before.accounts);
  for (const [preset, p] of Object.entries(result.presets)) {
    const tx = decode(p.tx);
    const accounts = resolveAccounts(tx, tables);
    expect(nonBudgetInstructions(tx, accounts), preset).toEqual(originalIxs);
    expect(tx.signed, preset).toBe(false);
    expect(tx.compiled.lifetimeToken, preset).toBe(result.blockhash);
    const budget = readComputeBudget(tx, accounts);
    expect(budget.limit, preset).toBe(result.computeUnitLimit);
    expect(budget.priorityFeeLamports, preset).toBe(p.priorityFeeLamports);
    expect(p.priorityFeeLamports).toBe(priorityFeeLamports(result.computeUnitLimit, BigInt(p.priceMicroLamports)).toString());
  }
  return { original, tables };
}

describe("optimizeWithRpc (replayed mainnet responses)", () => {
  it("fresh Jupiter v0 swap with lookup tables: rewritten transaction succeeds, instructions intact", async () => {
    const run = await optimize("jupiter-swap-fresh");
    const { result } = run;
    const { original } = expectFaithfulRewrites(run);
    expect(result.after.status).toEqual({ success: true });
    expect(result.computeUnitLimit).toBe(limitFor(result.before.unitsConsumed + addedBudgetCost(original, result.before.accounts)));
    expect(result.after.computeBudget.limit).toBe(result.computeUnitLimit);
    expect(result.after.computeBudget.priceMicroLamports).toBe(result.presets.p75.priceMicroLamports);
    expect(decode(result.presets.p75.tx).lookups.map((l) => l.table).sort()).toEqual(original.lookups.map((l) => l.table).sort());
    expect(Number(result.presets.p50.priceMicroLamports)).toBeLessThanOrEqual(Number(result.presets.p90.priceMicroLamports));
    expect(result.warnings.map((w) => w.code)).toEqual(["SIGNED"]);
    expect(result.credits).toBeLessThanOrEqual(12);
  });

  it("SOL transfer: inserts budget instructions sized to include their own cost", async () => {
    const run = await optimize("sol-transfer");
    const { result } = run;
    expectFaithfulRewrites(run);
    expect(result.after.status).toEqual({ success: true });
    expect(result.computeUnitLimit).toBe(limitFor(result.before.unitsConsumed + 300));
    expect(result.warnings.map((w) => w.code)).toEqual(["SIGNED", "NO_FEE_DATA"]);
  });

  it("v1 transaction: rewrites the config's limit and total priority fee", async () => {
    const run = await optimize("v1-transaction");
    const { result } = run;
    expectFaithfulRewrites(run);
    expect(result.after.version).toBe(1);
    expect(result.after.status).toEqual({ success: true });
    expect(result.after.computeBudget).toMatchObject({ priceMicroLamports: null, loadedAccountsDataSizeLimit: 35_000_000 });
    expect(result.after.fee.priorityLamports).toBe(result.presets.p75.priorityFeeLamports);
    expect(result.contention).toMatchObject({ paidSlotShare: expect.any(Number) });
  });

  it("probes at 1.4M when the original runs out of compute, then refuses the real failure (slippage)", async () => {
    // Recorded today: the original exhausts its 68,548 CU limit; at 1.4M it reaches Jupiter's slippage check.
    const { outcome, unused } = await replayOptimization("jupiter-slippage-6001");
    expect(unused).toBe(0); // includes the probe simulation
    expect(outcome).toMatchObject({
      ok: false,
      status: 422,
      error: {
        code: "OPTIMIZE_NOT_FIXABLE",
        message: "This transaction still fails with the maximum compute limit.",
        details: { error: { code: 6001, name: "SlippageToleranceExceeded" } },
      },
    });
  });

  it.each(["jupiter-swap-fresh", "sol-transfer", "v1-transaction"])("costs at most 12 credits for %s", async (name) => {
    expect((await optimize(name)).result.credits).toBeLessThanOrEqual(12);
  });
});

describe("isOutOfCompute", () => {
  const failed = (name: string, logs: string[] = []) =>
    ({ status: { success: false, error: { name } }, logs }) as unknown as SimulationResult;

  it("recognises the ComputationalBudgetExceeded error and the meter log line", () => {
    expect(isOutOfCompute(failed("ComputationalBudgetExceeded"))).toBe(true);
    expect(isOutOfCompute(failed("ProgramFailedToComplete", ["Program X consumed 200000 of 200000 compute units", "Program X failed: exceeded CUs meter at BPF instruction"]))).toBe(true);
  });

  it("does not treat other failures or successes as compute problems", () => {
    expect(isOutOfCompute(failed("SlippageToleranceExceeded"))).toBe(false);
    expect(isOutOfCompute({ status: { success: true }, logs: [] } as unknown as SimulationResult)).toBe(false);
  });
});

describe("limitFor", () => {
  it("adds 15% headroom, rounds up and caps at 1.4M", () => {
    expect(limitFor(150)).toBe(173);
    expect(limitFor(100)).toBe(115);
    expect(limitFor(1_300_000)).toBe(1_400_000);
    expect(limitFor(0)).toBe(1);
  });
});
