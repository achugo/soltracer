import type { SimulationResult } from "@soltracer/shared/simulation";
import type { RpcCallRecord } from "../../src/rpc/client.ts";
import { describe, expect, it } from "vitest";
import { replaySimulation } from "../helpers/replay.ts";
import { loadOnChain, SANDBOX_FIXTURES, type OnChainTx, type SandboxFixtureName } from "../helpers/sandbox-fixtures.ts";
import { recordingAvailable } from "../helpers/third-party.ts";

const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

async function simulate(name: SandboxFixtureName): Promise<SimulationResult> {
  const { outcome, unused } = await replaySimulation(name);
  if (!outcome.ok) throw new Error(outcome.error.message);
  expect(unused).toBe(0); // the simulator made exactly the recorded calls
  return outcome.result;
}

/** On-chain SOL deltas by address (meta.preBalances / postBalances). */
function onChainSol(fx: OnChainTx, result: SimulationResult): Map<string, string> {
  return new Map(
    result.accounts.flatMap((a, i) => {
      const delta = BigInt(fx.meta.postBalances[i] ?? 0) - BigInt(fx.meta.preBalances[i] ?? 0);
      return delta === 0n ? [] : [[a.address, delta.toString()]];
    }),
  );
}

/** On-chain token deltas by token account (meta.preTokenBalances / postTokenBalances). */
function onChainTokens(fx: OnChainTx, result: SimulationResult): Map<string, string> {
  const amounts = new Map<number, { pre: bigint; post: bigint }>();
  for (const b of fx.meta.preTokenBalances) amounts.set(b.accountIndex, { pre: BigInt(b.uiTokenAmount.amount), post: 0n });
  for (const b of fx.meta.postTokenBalances) {
    amounts.set(b.accountIndex, { pre: amounts.get(b.accountIndex)?.pre ?? 0n, post: BigInt(b.uiTokenAmount.amount) });
  }
  return new Map(
    [...amounts].flatMap(([i, { pre, post }]) =>
      post === pre ? [] : [[result.accounts[i]?.address ?? `#${i}`, (post - pre).toString()]],
    ),
  );
}

describe("simulateWithRpc (replayed mainnet responses)", () => {
  for (const name of SANDBOX_FIXTURES) {
    it.skipIf(!recordingAvailable(`sandbox/${name}.sim.json`))(`costs 6 credits or fewer for ${name}`, async () => {
      expect((await simulate(name)).credits).toBeLessThanOrEqual(6);
    });
  }

  it("SOL transfer: success, on-chain CU, fee and exact SOL deltas", async () => {
    const fx = loadOnChain("sol-transfer");
    const r = await simulate("sol-transfer");
    expect(r.status).toEqual({ success: true });
    expect(r.unitsConsumed).toBe(fx.meta.computeUnitsConsumed);
    expect(r.fee).toEqual({ baseLamports: "5000", priorityLamports: "0", totalLamports: "5000" });
    expect(new Map(r.balances.sol.map((s) => [s.address, s.delta]))).toEqual(onChainSol(fx, r));
    expect(r.balances.tokens).toEqual([]);
  });

  it("Jupiter swap with lookup tables: every account resolved, on-chain CU, fee and token deltas", async () => {
    const fx = loadOnChain("jupiter-swap-alt");
    const r = await simulate("jupiter-swap-alt");
    const loaded = fx.meta.loadedAddresses ?? { writable: [], readonly: [] };
    expect(r.accounts).toHaveLength(fx.meta.preBalances.length);
    expect(r.accounts.slice(-loaded.readonly.length).map((a) => a.address)).toEqual(loaded.readonly);
    expect(r.accounts.filter((a) => a.source.kind === "lookup")).toHaveLength(loaded.writable.length + loaded.readonly.length);
    expect(r.status).toEqual({ success: true });
    expect(r.unitsConsumed).toBe(fx.meta.computeUnitsConsumed);
    expect(r.fee.totalLamports).toBe(String(fx.meta.fee));
    // Simulated against today's pools: the same accounts move in the same direction and the
    // input side is exact, but the output amount reflects the current price, not the historical one.
    const simulated = new Map(r.balances.tokens.map((t) => [t.account, t.delta]));
    const onChain = onChainTokens(fx, r);
    expect([...simulated.keys()].sort()).toEqual([...onChain.keys()].sort());
    for (const [account, delta] of onChain) expect(Math.sign(Number(simulated.get(account)))).toBe(Math.sign(Number(delta)));
    const output = "Aykg2U57h48HD86jdco2xrXg8mw14tGNsR3ZjpZJKh22";
    for (const [account, delta] of onChain) {
      if (account !== output && account !== "9tPUjYv57xYvTGkyscwMMwQXCjn8viy47Qed3yLEkp7E") expect(simulated.get(account)).toBe(delta);
    }
    expect(simulated.get(output)).toBe("33875166883");
    expect(r.balances.tokens.find((t) => t.account === output)).toMatchObject({ decimals: 6, program: "token-2022" });
    expect(new Map(r.balances.sol.map((s) => [s.address, s.delta]))).toEqual(onChainSol(fx, r));
  });

  it.skipIf(!recordingAvailable("sandbox/jupiter-slippage-6001.sim.json"))("failed Jupiter swap: decoded slippage error, fee-only balance change", async () => {
    const fx = loadOnChain("jupiter-slippage-6001");
    const r = await simulate("jupiter-slippage-6001");
    expect(r.status).toMatchObject({
      success: false,
      error: {
        instructionIndex: 3,
        programId: JUP,
        failingProgramId: JUP,
        code: 6001,
        name: "SlippageToleranceExceeded",
        message: "Slippage tolerance exceeded",
        source: "idl",
      },
    });
    expect(r.fee.totalLamports).toBe(String(fx.meta.fee));
    // A failed transaction only charges the fee payer, exactly as on-chain.
    expect(new Map(r.balances.sol.map((s) => [s.address, s.delta]))).toEqual(onChainSol(fx, r));
    expect(r.balances.tokens).toEqual([]);
  });

  it("Token-2022 transfer simulated against today's state: raw custom error from a program without an IDL", async () => {
    const r = await simulate("token-2022-transfer");
    expect(r.status).toMatchObject({
      success: false,
      error: { code: 6002, name: null, source: "raw", message: expect.stringContaining("0x1772") },
    });
    expect(r.balances.sol).toHaveLength(1);
    expect(r.balances.sol[0]?.delta).toBe(`-${r.fee.totalLamports}`);
  });

  it("v1 transaction: config CU limit, 241-lamport priority fee, 5241 total", async () => {
    const r = await simulate("v1-transaction");
    expect(r.version).toBe(1);
    expect(r.status).toEqual({ success: true });
    expect(r.computeBudget).toMatchObject({ limit: 325_428, limitSource: "explicit", priceMicroLamports: null });
    expect(r.fee).toEqual({ baseLamports: "5000", priorityLamports: "241", totalLamports: "5241" });
  });

  /** Replaces the result.value of the recorded call for `method`. */
  const withValue = (method: string, value: (v: unknown) => unknown) => (records: RpcCallRecord[]) =>
    records.map((r) => {
      if (r.method !== method) return r;
      const response = r.response as { result: { value: unknown } };
      return { ...r, response: { ...response, result: { ...response.result, value: value(response.result.value) } } };
    });

  it("takes the base fee from getFeeForMessage when the blockhash is still valid", async () => {
    // Fixture blockhashes are stale (null); a fresh wallet transaction gets the total fee back.
    const { outcome } = await replaySimulation("jupiter-swap-alt", undefined, withValue("getFeeForMessage", () => 12_382n));
    if (!outcome.ok) throw new Error(outcome.error.message);
    expect(outcome.result.fee).toEqual({ baseLamports: "10000", priorityLamports: "2382", totalLamports: "12382" });
  });

  it("falls back to 5000 per signature when getFeeForMessage returns less than the priority fee", async () => {
    const { outcome } = await replaySimulation("jupiter-swap-alt", undefined, withValue("getFeeForMessage", () => 100n));
    if (!outcome.ok) throw new Error(outcome.error.message);
    expect(outcome.result.fee.baseLamports).toBe("10000");
  });

  it("rejects a successful simulation that comes back without account state", async () => {
    const strip = withValue("simulateTransaction", (v) => ({ ...(v as object), accounts: null }));
    await expect(replaySimulation("sol-transfer", undefined, strip)).rejects.toThrow(/returned no accounts/);
  });

  it("charges no fee when the transaction fails before executing", async () => {
    const preFee = withValue("simulateTransaction", (v) => ({ ...(v as object), err: "InsufficientFundsForFee" }));
    const { outcome } = await replaySimulation("sol-transfer", undefined, preFee);
    if (!outcome.ok) throw new Error(outcome.error.message);
    expect(outcome.result.status).toMatchObject({ success: false, error: { name: "InsufficientFundsForFee" } });
    expect(outcome.result.balances.sol).toEqual([]);
  });

  it("uses warm caches on a second run: no lookup-table or mint reads", async () => {
    const first = await replaySimulation("jupiter-swap-alt");
    const second = await replaySimulation("jupiter-swap-alt", first.caches);
    if (!second.outcome.ok) throw new Error(second.outcome.error.message);
    expect(second.outcome.result.credits).toBe(3);
  });

  it("returns a typed decode error without calling the RPC", async () => {
    const { outcome } = await replaySimulation("sol-transfer").then(async (r) => ({
      ...r,
      outcome: await import("../../src/sim/rpc-simulator.ts").then(({ simulateWithRpc }) =>
        simulateWithRpc("not a transaction", { rpc: undefined as never, credits: () => 0 }, r.caches),
      ),
    }));
    expect(outcome).toMatchObject({ ok: false, status: 400, error: { code: "TX_DECODE_FAILED" } });
  });
});
