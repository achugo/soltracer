import { MAX_LOG_LINE_CHARS, MAX_NODE_LOGS, MAX_TRACE_DEPTH, MAX_TRACE_NODES, traceSchema, type Trace, type TraceNode } from "@soltracer/shared/trace";
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { buildCpiTree } from "../../src/trace/cpi-tree.ts";
import { decodeTransactionInput } from "../../src/tx/decode.ts";
import { resolveAccounts } from "../../src/tx/lookup-tables.ts";
import { instructionPrograms } from "../../src/tx/programs.ts";
import { loadOnChain, ON_CHAIN_FIXTURES, tablesFromMeta, type OnChainFixtureName } from "../helpers/sandbox-fixtures.ts";

const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;
const WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc" as Address;
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const SYSTEM = "11111111111111111111111111111111" as Address;
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
const ED25519 = "Ed25519SigVerify111111111111111111111111111" as Address;

const invoke = (p: Address, depth: number) => `Program ${p} invoke [${depth}]`;
const consumed = (p: Address, n: number, of = 200_000) => `Program ${p} consumed ${n} of ${of} compute units`;
const success = (p: Address) => `Program ${p} success`;
const failed = (p: Address, why: string) => `Program ${p} failed: ${why}`;

function onChain(name: OnChainFixtureName) {
  const fx = loadOnChain(name);
  const decoded = decodeTransactionInput(fx.transaction[0]);
  if (!decoded.ok) throw new Error(decoded.error.message);
  const accounts = resolveAccounts(decoded.tx, tablesFromMeta(decoded.tx.lookups, fx));
  const err = fx.meta.err as { InstructionError?: [number, unknown] } | null;
  const trace = buildCpiTree({
    logs: fx.meta.logMessages,
    programs: instructionPrograms(decoded.tx, accounts),
    failed: err !== null,
    failedInstruction: err?.InstructionError?.[0] ?? null,
  });
  return { fx, accounts, trace };
}

function at(trace: Trace, id: number): TraceNode {
  const node = trace.nodes[id];
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

const children = (trace: Trace, id: number) => trace.nodes.filter((n) => n.parent === id);

describe("buildCpiTree on mainnet logs", () => {
  it.each(ON_CHAIN_FIXTURES)("%s: matches the chain's own inner instructions", (name) => {
    const { fx, accounts, trace } = onChain(name);
    expect(traceSchema.safeParse(trace).error).toBeUndefined();
    expect(trace.complete).toBe(true);

    const topLevel = trace.nodes.filter((n) => n.parent === null);
    expect(topLevel.map((n) => n.instructionIndex)).toEqual(topLevel.map((_, i) => i));

    // getTransaction lists every CPI with its stack height, in execution order: the tree must agree.
    for (const inner of fx.meta.innerInstructions ?? []) {
      const fromTree = trace.nodes
        .filter((n) => n.parent !== null && n.instructionIndex === inner.index)
        .map((n) => [n.depth, n.programId]);
      const fromChain = inner.instructions.map((ix) => [ix.stackHeight, accounts[ix.programIdIndex]?.address]);
      expect(fromTree, `${name} instruction ${inner.index}`).toEqual(fromChain);
    }
    const withInner = new Set((fx.meta.innerInstructions ?? []).map((i) => i.index));
    for (const node of trace.nodes.filter((n) => n.parent !== null)) {
      expect(withInner.has(node.instructionIndex), `${name}: CPI under instruction ${node.instructionIndex}`).toBe(true);
    }
    const ran = trace.nodes.filter((n) => n.status !== "not-run" && n.parent === null);
    const totalTopLevel = ran.reduce((sum, n) => sum + (n.consumed ?? 0), 0);
    expect(totalTopLevel).toBeLessThanOrEqual(fx.meta.computeUnitsConsumed);
  });

  it("jupiter-slippage-6001: Jupiter itself fails after its hops; later instructions never run", () => {
    const { trace } = onChain("jupiter-slippage-6001");
    const failing = at(trace, trace.failingNodeId ?? -1);
    expect(failing).toMatchObject({ programId: JUP, depth: 1, instructionIndex: 3, status: "failed", consumed: 48_305, budget: 54_835 });
    expect(failing.logs).toContain(`Program ${JUP} failed: custom program error: 0x1771`);
    expect(failing.logs).toContain("Program log: Instruction: SharedAccountsRoute");

    const hops = children(trace, failing.id);
    expect(hops.map((n) => [n.programId, n.status, n.consumed])).toEqual([
      [TOKEN, "success", 76],
      [WHIRLPOOL, "success", 39_989],
      [JUP, "success", 91],
    ]);
    expect(failing.selfConsumed).toBe(48_305 - 76 - 39_989 - 91);

    const whirlpool = hops[1];
    if (!whirlpool) throw new Error("no whirlpool hop");
    expect(whirlpool.selfConsumed).toBe(39_989 - 105 - 112);
    expect(whirlpool.logs[0]).toBe("Program log: Instruction: SwapV2");
    expect(whirlpool.logs.some((l) => l.startsWith("Program data: "))).toBe(true);
    expect(whirlpool.logs.some((l) => l.includes(TOKEN))).toBe(false); // the Token CPIs' lines are theirs

    const after = trace.nodes.filter((n) => n.parent === null && n.instructionIndex > 3);
    expect(after.map((n) => n.status)).toEqual(["not-run", "not-run", "not-run"]);
    expect(after.every((n) => n.consumed === null && n.logs.length === 0)).toBe(true);
  });

  it("jupiter-slippage-6001: the ATA program's CPIs carry return data, and a builtin child leaves self CU unknown", () => {
    const { trace } = onChain("jupiter-slippage-6001");
    const ata = trace.nodes.find((n) => n.programId === ATA);
    if (!ata) throw new Error("no ATA node");
    expect(ata).toMatchObject({ status: "success", consumed: 13_413, selfConsumed: null });
    const [first, system] = children(trace, ata.id);
    expect(first?.returnData).toEqual({ programId: TOKEN, dataBase64: "pQAAAAAAAAA=" });
    expect(first?.logs).toEqual([`Program return: ${TOKEN} pQAAAAAAAAA=`]);
    expect(system).toMatchObject({ programId: SYSTEM, consumed: null, selfConsumed: null, status: "success" });
  });
});

describe("buildCpiTree edge cases", () => {
  const run = (logs: string[], programs: Address[], failedInstruction: number | null = null, isFailed = failedInstruction !== null) => {
    const trace = buildCpiTree({ logs, programs, failed: isFailed, failedInstruction });
    expect(traceSchema.safeParse(trace).error).toBeUndefined();
    return trace;
  };

  it("marks the deepest failing CPI as the failing node, and its callers failed too", () => {
    const trace = run(
      [
        invoke(JUP, 1),
        invoke(WHIRLPOOL, 2),
        invoke(TOKEN, 3),
        "Program log: Error: insufficient funds",
        consumed(TOKEN, 1_200),
        failed(TOKEN, "custom program error: 0x1"),
        consumed(WHIRLPOOL, 30_000),
        failed(WHIRLPOOL, "custom program error: 0x1"),
        consumed(JUP, 40_000),
        failed(JUP, "custom program error: 0x1"),
      ],
      [JUP],
      0,
    );
    expect(trace.failingNodeId).toBe(2);
    expect(trace.nodes.map((n) => n.status)).toEqual(["failed", "failed", "failed"]);
    expect(at(trace, 2).logs).toEqual(["Program log: Error: insufficient funds", failed(TOKEN, "custom program error: 0x1")]);
    expect(trace.nodes.map((n) => n.selfConsumed)).toEqual([10_000, 28_800, 1_200]);
  });

  it("records a compute budget overrun with what was consumed", () => {
    const trace = run([invoke(JUP, 1), consumed(JUP, 200_000), failed(JUP, "exceeded CUs meter at BPF instruction")], [JUP], 0);
    expect(at(trace, 0)).toMatchObject({ status: "failed", consumed: 200_000, budget: 200_000 });
  });

  it("truncated logs: open nodes and unseen instructions are incomplete", () => {
    const trace = run([invoke(JUP, 1), invoke(WHIRLPOOL, 2), "Program log: swapping", "Log truncated"], [JUP, TOKEN]);
    expect(trace.complete).toBe(false);
    expect(trace.nodes.map((n) => [n.programId, n.status])).toEqual([
      [JUP, "incomplete"],
      [WHIRLPOOL, "incomplete"],
      [TOKEN, "incomplete"],
    ]);
    expect(trace.failingNodeId).toBeNull();
  });

  it("truncated logs of a failed transaction: the failing instruction is still marked", () => {
    const trace = run([invoke(SYSTEM, 1), success(SYSTEM), invoke(JUP, 1), invoke(WHIRLPOOL, 2), "Log truncated"], [SYSTEM, JUP, TOKEN, TOKEN], 1);
    expect(trace.nodes.map((n) => [n.programId, n.status])).toEqual([
      [SYSTEM, "success"],
      [JUP, "failed"],
      [WHIRLPOOL, "incomplete"],
      [TOKEN, "not-run"],
      [TOKEN, "not-run"],
    ]);
    expect(trace.failingNodeId).toBe(1);
    expect(trace.complete).toBe(false);
  });

  it("truncated before a failing instruction it never reached: earlier ones succeeded", () => {
    const trace = run([invoke(SYSTEM, 1), "Log truncated"], [SYSTEM, TOKEN, JUP, TOKEN], 2);
    expect(trace.nodes.map((n) => n.status)).toEqual(["incomplete", "success", "failed", "not-run"]);
    expect(trace.failingNodeId).toBe(2);
  });

  it("an instruction that logs nothing (a precompile) gets a node in order", () => {
    const trace = run([invoke(JUP, 1), consumed(JUP, 900), success(JUP)], [ED25519, JUP]);
    expect(trace.nodes.map((n) => [n.programId, n.status, n.instructionIndex])).toEqual([
      [ED25519, "success", 0],
      [JUP, "success", 1],
    ]);
    expect(trace.complete).toBe(true);
  });

  it("a successful transaction whose last instruction logs nothing", () => {
    const trace = run([invoke(JUP, 1), success(JUP)], [JUP, ED25519]);
    expect(trace.nodes.map((n) => n.status)).toEqual(["success", "success"]);
  });

  it("a failure before execution (no logs): nothing ran and nothing is the failing node", () => {
    const trace = run([], [SYSTEM, JUP], null, true);
    expect(trace.nodes.map((n) => n.status)).toEqual(["not-run", "not-run"]);
    expect(trace.failingNodeId).toBeNull();
    expect(trace.complete).toBe(true);
  });

  it("a failing instruction with no logs of its own (a precompile) is the failing node", () => {
    const trace = run([], [ED25519, JUP], 0);
    expect(trace.nodes.map((n) => n.status)).toEqual(["failed", "not-run"]);
    expect(trace.failingNodeId).toBe(0);
  });

  it("a transaction-level error after execution: a trailing silent instruction still ran", () => {
    const trace = run([invoke(JUP, 1), success(JUP)], [JUP, ED25519], null, true);
    expect(trace.nodes.map((n) => n.status)).toEqual(["success", "success"]);
    expect(trace.failingNodeId).toBeNull();
  });

  it("caps nesting at the deepest level the trace allows", () => {
    const programs = [JUP];
    const logs = [invoke(JUP, 1), ...Array.from({ length: MAX_TRACE_DEPTH + 4 }, (_, i) => invoke(TOKEN, i + 2))];
    const trace = run(logs, programs);
    expect(Math.max(...trace.nodes.map((n) => n.depth))).toBe(MAX_TRACE_DEPTH);
    expect(trace.complete).toBe(false);
  });

  it("caps logs per node and the length of each line", () => {
    const lines = Array.from({ length: MAX_NODE_LOGS + 50 }, (_, i) => `Program log: ${i}`);
    const trace = run([invoke(JUP, 1), "Program log: " + "x".repeat(MAX_LOG_LINE_CHARS * 2), ...lines, success(JUP)], [JUP]);
    const node = at(trace, 0);
    expect(node.logs).toHaveLength(MAX_NODE_LOGS);
    expect(node.logsDropped).toBe(51);
    expect(node.logs[0]).toHaveLength(MAX_LOG_LINE_CHARS);
  });

  it("stops at the node cap and says the trace is incomplete", () => {
    const logs = [invoke(JUP, 1), ...Array.from({ length: MAX_TRACE_NODES + 10 }, () => [invoke(TOKEN, 2), success(TOKEN)]).flat(), success(JUP)];
    const trace = run(logs, [JUP]);
    expect(trace.nodes).toHaveLength(MAX_TRACE_NODES);
    expect(trace.complete).toBe(false);
  });

  it("ignores a consumed, success or return line that names another program", () => {
    const trace = run(
      [invoke(JUP, 1), consumed(TOKEN, 5), `Program return: ${TOKEN} AQ==`, success(TOKEN), consumed(JUP, 10), success(JUP)],
      [JUP],
    );
    expect(at(trace, 0)).toMatchObject({ consumed: 10, status: "success", returnData: null });
    expect(at(trace, 0).logs).toHaveLength(3);
  });

  it("self CU is unknown when the children report more than the caller", () => {
    const trace = run([invoke(JUP, 1), invoke(TOKEN, 2), consumed(TOKEN, 900), success(TOKEN), consumed(JUP, 500), success(JUP)], [JUP]);
    expect(at(trace, 0).selfConsumed).toBeNull();
  });

  it("a blank line between instructions is harmless", () => {
    expect(run([invoke(JUP, 1), success(JUP), ""], [JUP]).complete).toBe(true);
  });

  it("ignores return data that isn't valid base64", () => {
    const trace = run([invoke(JUP, 1), `Program return: ${JUP} !!!`, success(JUP)], [JUP]);
    expect(at(trace, 0).returnData).toBeNull();
  });

  it("malformed logs never throw: a skipped level, a missing end line, an unknown program", () => {
    const skipped = run([invoke(JUP, 1), invoke(TOKEN, 3), success(TOKEN), success(JUP)], [JUP]);
    expect(skipped.complete).toBe(false);
    expect(at(skipped, 1)).toMatchObject({ parent: 0, depth: 2 });

    const unclosed = run([invoke(JUP, 1), invoke(TOKEN, 2), invoke(SYSTEM, 2), success(SYSTEM), success(JUP)], [JUP]);
    expect(unclosed.complete).toBe(false);
    expect(unclosed.nodes.map((n) => n.status)).toEqual(["success", "incomplete", "success"]);

    const unknown = run([invoke(WHIRLPOOL, 1), success(WHIRLPOOL)], [JUP]);
    expect(unknown.complete).toBe(false);
    expect(unknown.nodes.map((n) => [n.programId, n.status])).toEqual([[JUP, "incomplete"]]);

    const orphan = run([invoke(TOKEN, 2), success(TOKEN), "Program log: stray"], [JUP]);
    expect(orphan.complete).toBe(false);

    const zero = run([invoke(JUP, 1), `Program ${TOKEN} invoke [0]`, success(JUP)], [JUP]);
    expect(zero.complete).toBe(false);
    expect(zero.nodes).toHaveLength(1);

    const notAnId = run([invoke(JUP, 1), "Program not_a_key invoke [2]", success(JUP)], [JUP]);
    expect(notAnId.nodes).toHaveLength(1);
    expect(at(notAnId, 0).logs).toEqual(["Program not_a_key invoke [2]"]);

    const unfinished = run([invoke(JUP, 1), invoke(SYSTEM, 1), success(SYSTEM)], [JUP, SYSTEM]);
    expect(unfinished.complete).toBe(false);
    expect(unfinished.nodes.map((n) => n.status)).toEqual(["incomplete", "success"]);
  });
});
