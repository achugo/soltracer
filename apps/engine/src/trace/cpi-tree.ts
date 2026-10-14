import {
  MAX_LOG_LINE_CHARS,
  MAX_NODE_LOGS,
  MAX_RETURN_DATA_BYTES,
  MAX_TRACE_DEPTH,
  MAX_TRACE_NODES,
  type Trace,
  type TraceNode,
  type TraceNodeStatus,
} from "@soltracer/shared/trace";
import type { Address } from "@solana/kit";

// Program ids are base58; anything else is an ordinary log line.
const ID = "([1-9A-HJ-NP-Za-km-z]{32,44})";
const INVOKE = new RegExp(`^Program ${ID} invoke \\[(\\d+)\\]$`);
const CONSUMED = new RegExp(`^Program ${ID} consumed (\\d+) of (\\d+) compute units$`);
const SUCCESS = new RegExp(`^Program ${ID} success$`);
const FAILED = new RegExp(`^Program ${ID} failed: `);
const RETURN = new RegExp(`^Program return: ${ID} (\\S*)$`);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** The runtime's log collector ends with this line once it runs out of space. */
const TRUNCATED = "Log truncated";

export interface CpiTreeInput {
  logs: readonly string[];
  /** Program of each top-level instruction, in order. */
  programs: readonly Address[];
  /** Whether the transaction failed. */
  failed: boolean;
  /** Top-level instruction the error names (InstructionError), if any. */
  failedInstruction: number | null;
}

/**
 * Builds the CPI tree from runtime logs: one node per invoke, in execution order, with its own log
 * lines, CU and outcome. Top-level instructions that log nothing (precompiles) or never ran still get
 * a node. The deepest failed node is the failing one. Malformed or truncated logs never throw: the
 * trace is marked incomplete instead. Errors and instruction data are attached later by the caller.
 */
export function buildCpiTree({ logs, programs, failed, failedInstruction }: CpiTreeInput): Trace {
  const nodes: TraceNode[] = [];
  const stack: TraceNode[] = [];
  let next = 0; // next top-level instruction without a node
  let complete = true;
  let truncated = false;
  let capped = false; // MAX_TRACE_NODES reached
  let lost = false; // the logs name an instruction the transaction doesn't have
  let failingNodeId: number | null = null;

  function add(programId: string, parent: TraceNode | null, instructionIndex: number, status: TraceNodeStatus): TraceNode | null {
    if (nodes.length >= MAX_TRACE_NODES) {
      capped = true;
      return null;
    }
    const node: TraceNode = {
      id: nodes.length,
      parent: parent?.id ?? null,
      depth: parent ? parent.depth + 1 : 1,
      instructionIndex,
      programId,
      status,
      consumed: null,
      budget: null,
      selfConsumed: null,
      error: null,
      logs: [],
      logsDropped: 0,
      returnData: null,
      instruction: null,
    };
    nodes.push(node);
    return node;
  }

  function log(node: TraceNode, line: string) {
    if (node.logs.length < MAX_NODE_LOGS) node.logs.push(line.slice(0, MAX_LOG_LINE_CHARS));
    else node.logsDropped += 1;
  }

  /** Nodes left open where an end line was expected: the logs are malformed. */
  function abandonOpen(keep: number) {
    if (stack.length > keep) complete = false;
    stack.length = Math.min(stack.length, keep);
  }

  for (const line of logs) {
    if (capped) break;
    if (line === TRUNCATED) {
      truncated = true;
      break;
    }
    const invoke = INVOKE.exec(line);
    if (invoke) {
      const [, programId = "", depthText = ""] = invoke;
      const depth = Number(depthText);
      if (depth < 1) {
        complete = false;
        continue;
      }
      if (depth === 1) {
        abandonOpen(0);
        const index = programs.indexOf(programId as Address, next);
        if (index === -1) {
          lost = true;
          break;
        }
        // Instructions in between logged nothing (precompiles) and must have succeeded.
        for (; next < index; next++) add(programs[next] ?? "", null, next, "success");
        next = index + 1;
        const node = add(programId, null, index, "incomplete");
        if (node) stack.push(node);
        continue;
      }
      if (depth > stack.length + 1) complete = false; // a skipped level: attach to the deepest open node
      abandonOpen(depth - 1);
      const parent = stack.at(-1);
      if (!parent || parent.depth >= MAX_TRACE_DEPTH) {
        complete = false; // a CPI outside any instruction, or nested deeper than the trace allows
        continue;
      }
      const node = add(programId, parent, parent.instructionIndex, "incomplete");
      if (node) stack.push(node);
      continue;
    }

    const current = stack.at(-1);
    if (!current) {
      if (line.trim() !== "") complete = false; // a line outside any instruction
      continue;
    }
    const used = CONSUMED.exec(line);
    if (used && used[1] === current.programId) {
      current.consumed = Number(used[2]);
      current.budget = Number(used[3]);
      continue;
    }
    if (SUCCESS.exec(line)?.[1] === current.programId) {
      current.status = "success";
      stack.pop();
      continue;
    }
    if (FAILED.exec(line)?.[1] === current.programId) {
      log(current, line);
      current.status = "failed";
      failingNodeId ??= current.id; // children end first, so the first failure is the deepest
      stack.pop();
      continue;
    }
    const returned = RETURN.exec(line);
    const data = returned?.[2] ?? "";
    if (returned?.[1] === current.programId && BASE64.test(data) && data.length <= Math.ceil(MAX_RETURN_DATA_BYTES / 3) * 4) {
      current.returnData = { programId: current.programId, dataBase64: data };
    }
    log(current, line);
  }

  // Still-open nodes: callers of the failing node failed with it; the failing top-level instruction
  // is known from the error even when its logs were cut off; anything else is incomplete.
  if (stack.length > 0) {
    if (!truncated) complete = false;
    const failing = failingNodeId === null ? undefined : nodes[failingNodeId];
    for (const open of stack) {
      if (failing && isAncestor(nodes, open.id, failing)) open.status = "failed";
    }
    // With the logs cut off, which hop failed is unknown: only the top-level instruction is marked.
    const top = stack[0];
    if (failed && failingNodeId === null && top && top.instructionIndex === failedInstruction) {
      top.status = "failed";
      failingNodeId = top.id;
    }
  }

  for (; next < programs.length && !capped; next++) {
    let status: TraceNodeStatus;
    if (lost) {
      status = "incomplete";
    } else if (failed) {
      // No index: a transaction-level error. Before execution nothing ran (no logs); after it, everything did.
      if (failedInstruction === null) status = logs.length === 0 ? "not-run" : "success";
      else if (next > failedInstruction) status = "not-run";
      else if (next < failedInstruction) status = "success";
      else status = "failed";
    } else {
      status = truncated ? "incomplete" : "success";
    }
    const node = add(programs[next] ?? "", null, next, status);
    if (node && status === "failed") failingNodeId ??= node.id;
  }
  for (const node of nodes) node.selfConsumed = selfUnits(nodes, node);
  if (truncated || capped || lost || nodes.some((n) => n.status === "incomplete")) complete = false;
  return { nodes, failingNodeId, complete };
}

function isAncestor(nodes: readonly TraceNode[], id: number, of: TraceNode): boolean {
  for (let p = of.parent; p !== null; p = nodes[p]?.parent ?? null) if (p === id) return true;
  return false;
}

/** CU spent in the node's own code: its total minus its children's. Unknown if any of those is. */
function selfUnits(nodes: readonly TraceNode[], node: TraceNode): number | null {
  if (node.consumed === null) return null;
  let rest = node.consumed;
  for (const child of nodes) {
    if (child.parent !== node.id) continue;
    if (child.consumed === null) return null;
    rest -= child.consumed;
  }
  return rest >= 0 ? rest : null;
}
