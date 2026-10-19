import type { Override, SimulationResult } from "@soltracer/shared/simulation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "../../../src/rpc/rate-limiter.ts";
import { COMPARISON_FIXTURES, replayEngine, type ComparisonName } from "../../helpers/replay.ts";
import { comparisonAvailable } from "../../helpers/third-party.ts";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Both sides of a comparison recording can be replayed here (third-party binaries are in the local cache). */
const replayable = (...names: ComparisonName[]) => names.every((n) => comparisonAvailable(n, "rpc") && comparisonAvailable(n, "local"));

async function run(name: ComparisonName, engine: "rpc" | "local", overrides?: Override[]) {
  const { outcome, unused } = await replayEngine(name, engine, { overrides, unrecordedAccountsMissing: overrides !== undefined });
  if (!outcome.ok) throw new Error(`${name}/${engine}: ${outcome.error.code} ${outcome.error.message}`);
  if (!overrides) expect(unused, `${name}/${engine} made every recorded call`).toBe(0);
  return outcome.result;
}

/** What "agree" means in the docs: outcome, error and balance deltas. */
function comparable(r: SimulationResult) {
  return {
    success: r.status.success,
    error: r.status.success ? null : { name: r.status.error.name, code: r.status.error.code, instruction: r.status.error.instructionIndex },
    sol: Object.fromEntries(r.balances.sol.map((s) => [s.address, s.delta])),
    tokens: Object.fromEntries(r.balances.tokens.map((t) => [t.account, t.delta])),
  };
}

/**
 * Live pools: rpc and local ran a few seconds apart, so the pool's price moved slightly between
 * them. Same outcome, same accounts moving in the same direction, amounts within 1%.
 */
const MOVING_POOL_FIXTURES = new Set<ComparisonName>(["jupiter-usdc-input"]);

function expectClose(local: Record<string, string>, rpc: Record<string, string>) {
  expect(Object.keys(local).sort()).toEqual(Object.keys(rpc).sort());
  for (const [account, delta] of Object.entries(rpc)) {
    const a = BigInt(local[account] ?? "0");
    const b = BigInt(delta);
    expect(a < 0n, account).toBe(b < 0n);
    const diff = a > b ? a - b : b - a;
    expect(diff * 100n <= (b < 0n ? -b : b), `${account}: ${a} vs ${b}`).toBe(true);
  }
}

/**
 * rpc mode reads "before" balances with a separate getMultipleAccounts just before simulating, so on
 * accounts that change every slot its deltas include other people's transactions. The v1 fixture is a
 * bot that trades every slot against a busy pool; local mode takes before and after from one snapshot.
 */
const HOT_ACCOUNT_FIXTURES = new Set<ComparisonName>(["v1-transaction"]);

describe("local (LiteSVM) agrees with rpc simulateTransaction", () => {
  for (const name of COMPARISON_FIXTURES.filter((n) => !HOT_ACCOUNT_FIXTURES.has(n) && !MOVING_POOL_FIXTURES.has(n))) {
    it.skipIf(!replayable(name))(`${name}: same outcome, error and balance deltas`, async () => {
      const rpc = await run(name, "rpc");
      const local = await run(name, "local");
      expect(local.engine).toBe("local");
      expect(comparable(local)).toEqual(comparable(rpc));
      expect(local.credits).toBeLessThanOrEqual(rpc.credits);
    });
  }

  it.skipIf(!replayable("jupiter-usdc-input"))("USDC swap on a live pool: same outcome, same accounts and direction, amounts within 1%", async () => {
    const rpcResult = await run("jupiter-usdc-input", "rpc");
    const rpc = comparable(rpcResult);
    const local = comparable(await run("jupiter-usdc-input", "local"));
    expect(local.success).toBe(rpc.success);
    expect(local.error).toEqual(rpc.error);
    expectClose(local.tokens, rpc.tokens);
    // SOL-only accounts such as fee and tip collectors are hot (see HOT_ACCOUNT_FIXTURES); compare the
    // fee payer and the token accounts, whose lamports move with this transaction alone.
    const payer = rpcResult.accounts[0]?.address ?? "";
    const scoped = (sol: Record<string, string>) =>
      Object.fromEntries(Object.entries(sol).filter(([a]) => a === payer || a in rpc.tokens));
    expectClose(scoped(local.sol), scoped(rpc.sol));
  });

  it.skipIf(!replayable("v1-transaction"))("v1 (hot accounts): same outcome and error; locally the payer pays exactly the fee", async () => {
    const rpc = await run("v1-transaction", "rpc");
    const local = await run("v1-transaction", "local");
    expect(comparable(local).success).toBe(comparable(rpc).success);
    expect(comparable(local).error).toEqual(comparable(rpc).error);
    const payer = local.accounts[0]?.address;
    expect(local.balances.sol.find((s) => s.address === payer)?.delta).toBe(`-${local.fee.totalLamports}`);
    // Every token account that moved locally moved the same way under rpc (rpc may show extra hot accounts).
    const rpcTokens = comparable(rpc).tokens;
    for (const [account, delta] of Object.entries(comparable(local).tokens)) {
      expect(account in rpcTokens, account).toBe(true);
      expect(BigInt(delta) < 0n, account).toBe(BigInt(rpcTokens[account] ?? "0") < 0n);
    }
  });

  it.skipIf(!replayable("jupiter-swap-fresh"))("captures full logs and per-instruction CU locally", async () => {
    const local = await run("jupiter-swap-fresh", "local");
    expect(local.logs.some((l) => l.includes("Program log: Instruction: Route") || l.includes("invoke [1]"))).toBe(true);
    const jupiter = local.perInstruction.find((p) => p.programId === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
    expect(jupiter?.unitsConsumed).toBeGreaterThan(0);
  });
});

describe("overrides", () => {
  it.skipIf(!replayable("jupiter-usdc-input"))("turns the USDC swap into a failure at 0 USDC and back into a success with enough USDC", async () => {
    const base = await run("jupiter-usdc-input", "local");
    expect(base.status.success).toBe(true);
    const payer = base.accounts[0]?.address ?? "";

    const broke = await run("jupiter-usdc-input", "local", [{ kind: "token", owner: payer, mint: USDC, amount: "0" }]);
    expect(broke.status.success).toBe(false);

    const rich = await run("jupiter-usdc-input", "local", [{ kind: "token", owner: payer, mint: USDC, amount: "1000000000000000" }]);
    expect(rich.status).toEqual({ success: true });
    expect(rich.overrides).toHaveLength(1);
  });
});

describe("rate limit", () => {
  afterEach(() => vi.useRealTimers());

  // Every fixture whose local side can be replayed here (all of them when the third-party cache is present).
  const local = COMPARISON_FIXTURES.filter((n) => comparisonAvailable(n, "local"));
  it.skipIf(local.length === 0)("cold local runs of every fixture at once never exceed 10 RPC calls in any 1 s window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date", "performance"] });
    const limiter = createRateLimiter({ limit: 10, windowMs: 1000, maxQueue: 100 });
    const times: number[] = [];
    let settled = false;
    const runs = Promise.all(
      local.map((name) => replayEngine(name, "local", { limiter, onCall: () => times.push(Date.now()) })),
    ).finally(() => (settled = true));
    // Keep the fake clock moving until every run has drained through the limiter.
    for (let i = 0; i < 200 && !settled; i++) await vi.advanceTimersByTimeAsync(100);
    const outcomes = await runs;
    expect(outcomes.every((o) => o.outcome.ok)).toBe(true);
    expect(times.length).toBeGreaterThan(10); // enough calls for the limit to matter
    const maxInWindow = Math.max(...times.map((t) => times.filter((u) => u >= t && u < t + 1000).length));
    expect(maxInWindow).toBeLessThanOrEqual(10);
  });
});
