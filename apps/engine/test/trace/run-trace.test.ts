import { simulationResultSchema, type SimulationResult } from "@soltracer/shared/simulation";
import type { TraceNode } from "@soltracer/shared/trace";
import { describe, expect, it } from "vitest";
import { failedInstructionOf } from "../../src/trace/run-trace.ts";
import { COMPARISON_FIXTURES, replayEngine } from "../helpers/replay.ts";
import { comparisonAvailable } from "../helpers/third-party.ts";

const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";

async function run(name: (typeof COMPARISON_FIXTURES)[number], engine: "rpc" | "local"): Promise<SimulationResult> {
  const { outcome } = await replayEngine(name, engine);
  if (!outcome.ok) throw new Error(outcome.error.message);
  expect(simulationResultSchema.safeParse(outcome.result).error).toBeUndefined();
  return outcome.result;
}

function node(result: SimulationResult, id: number | null): TraceNode {
  const found = id === null ? undefined : result.trace.nodes[id];
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

describe("trace acceptance: the failed multi-hop Jupiter swap (jupiter-slippage-6001)", () => {
  it.skipIf(!comparisonAvailable("jupiter-slippage-6001", "local"))("local: shows the failing node, its program, the decoded error, the CU split and every hop's data", async () => {
    const result = await run("jupiter-slippage-6001", "local");
    const failing = node(result, result.trace.failingNodeId);
    expect(failing.programId).toBe(JUP);
    expect(failing.error).toMatchObject({ code: 6001, name: "SlippageToleranceExceeded", source: "idl" });
    expect(failing.instruction?.decoded?.name).toBe("shared_accounts_route");
    expect(failing.instruction?.decoded?.accountNames[0]).toBe("token_program");

    const hops = result.trace.nodes.filter((n) => n.parent === failing.id);
    expect(hops.map((h) => h.programId)).toContain(WHIRLPOOL);
    for (const hop of hops) {
      expect(hop.status).toBe("success");
      expect(hop.consumed).not.toBeNull();
      expect(hop.instruction?.data).toMatch(/^[0-9a-f]+$/); // LiteSVM gives every CPI its data
    }
    // CU split: the failing node's own work plus its hops add up to its total.
    expect((failing.selfConsumed ?? 0) + hops.reduce((n, h) => n + (h.consumed ?? 0), 0)).toBe(failing.consumed);

    // A program without a (cached) IDL renders with its program id and raw data.
    const whirlpool = hops.find((h) => h.programId === WHIRLPOOL);
    expect(whirlpool?.instruction).toMatchObject({ decoded: null });
    expect(whirlpool?.instruction?.accounts.length).toBeGreaterThan(0);

    const after = result.trace.nodes.filter((n) => n.parent === null && n.instructionIndex > failing.instructionIndex);
    expect(after.every((n) => n.status === "not-run")).toBe(true);
  });

  it.skipIf(!comparisonAvailable("jupiter-slippage-6001", "rpc"))("rpc: the same failing node and error; only top-level instructions carry data", async () => {
    const result = await run("jupiter-slippage-6001", "rpc");
    const failing = node(result, result.trace.failingNodeId);
    expect(failing).toMatchObject({ programId: JUP, error: { code: 6001, name: "SlippageToleranceExceeded" } });
    expect(failing.instruction?.decoded?.name).toBe("shared_accounts_route");
    const cpis = result.trace.nodes.filter((n) => n.parent !== null);
    expect(cpis.length).toBeGreaterThan(0);
    expect(cpis.every((n) => n.instruction === null)).toBe(true);
  });
});

describe("every recorded transaction gets a trace and account diffs", () => {
  for (const name of COMPARISON_FIXTURES) {
    it.skipIf(!comparisonAvailable(name, "local"))(`${name} (local): CPI data is matched for every instruction, diffs cover the balance changes`, async () => {
      const result = await run(name, "local");
      expect(result.trace.complete).toBe(true);
      const topLevel = result.trace.nodes.filter((n) => n.parent === null);
      expect(topLevel).toHaveLength(result.perInstruction.length);
      for (const n of result.trace.nodes.filter((x) => x.status !== "not-run")) expect(n.instruction, `${name} node ${n.id}`).not.toBeNull();

      const changed = new Set(result.accountDiffs.map((d) => d.address));
      for (const s of result.balances.sol) expect(changed.has(s.address), `${name} ${s.address}`).toBe(true);
      for (const t of result.balances.tokens) expect(changed.has(t.account), `${name} ${t.account}`).toBe(true);
    });
  }

  for (const name of COMPARISON_FIXTURES) {
    it.skipIf(!comparisonAvailable(name, "rpc") || !comparisonAvailable(name, "local"))(`${name} (rpc): the tree agrees with the local one`, async () => {
      const [rpc, local] = await Promise.all([run(name, "rpc"), run(name, "local")]);
      const shape = (r: SimulationResult) => r.trace.nodes.map((n) => [n.depth, n.programId, n.status]);
      // Account state can move between the back-to-back recordings, but which instructions ran and how they ended doesn't.
      expect(shape(rpc).filter(([d]) => d === 1)).toEqual(shape(local).filter(([d]) => d === 1));
      expect(rpc.trace.complete).toBe(true);
    });
  }
});

describe("failedInstructionOf", () => {
  it("reads the index whether the transport parsed it as a number or a BigInt", () => {
    expect(failedInstructionOf({ InstructionError: [3, { Custom: 6001 }] })).toBe(3);
    expect(failedInstructionOf({ InstructionError: [3n, { Custom: 6001n }] })).toBe(3);
    expect(failedInstructionOf({ InsufficientFundsForRent: { account_index: 1 } })).toBeNull();
    expect(failedInstructionOf("AccountNotFound")).toBeNull();
    expect(failedInstructionOf(null)).toBeNull();
    expect(failedInstructionOf({ InstructionError: "odd" })).toBeNull();
    expect(failedInstructionOf({ InstructionError: [-1, "x"] })).toBeNull();
  });
});
