import type { SimulationResult } from "@soltracer/shared/simulation";
import {
  MAX_INSTRUCTION_ACCOUNTS,
  MAX_INSTRUCTION_DATA_BYTES,
  type Trace,
  type TraceInstruction,
  type TraceNode,
} from "@soltracer/shared/trace";
import type { Address } from "@solana/kit";
import { decodeIdlInstruction, type NormalizedIdl } from "../decode/idl-full.ts";
import type { InnerInstruction } from "../sim/local/runner.ts";
import type { TopLevelInstruction } from "../tx/instructions.ts";

export interface TraceDetails {
  status: SimulationResult["status"];
  instructions: readonly TopLevelInstruction[];
  /** The transaction's accounts, in order: what inner instruction indices point into. */
  accountKeys: readonly Address[];
  /** CPIs per top-level instruction (local runs); null when unknown (rpc runs). */
  inner: readonly (readonly InnerInstruction[])[] | null;
  idls: ReadonlyMap<string, NormalizedIdl>;
}

function describe(programId: string, accounts: readonly string[], data: Uint8Array, idls: TraceDetails["idls"]): TraceInstruction | null {
  if (data.length > MAX_INSTRUCTION_DATA_BYTES) return null; // too large to carry; the node still shows its program and CU
  const shown = accounts.slice(0, MAX_INSTRUCTION_ACCOUNTS);
  const idl = idls.get(programId);
  return {
    data: Buffer.from(data).toString("hex"),
    accounts: [...shown],
    decoded: idl ? decodeIdlInstruction(idl, data, shown.length) : null,
  };
}

/**
 * Inner instructions for one top-level instruction, matched to its CPI nodes by execution order.
 * Attached only when the count, stack heights and programs all agree; otherwise none are, so data is
 * never shown on the wrong node.
 */
function matchInner(
  nodes: readonly TraceNode[],
  inner: readonly InnerInstruction[],
  accountKeys: TraceDetails["accountKeys"],
): (InnerInstruction & { accountAddresses: Address[] })[] | null {
  if (nodes.length !== inner.length) return null;
  const matched: (InnerInstruction & { accountAddresses: Address[] })[] = [];
  for (const [i, ix] of inner.entries()) {
    const node = nodes[i];
    const accountAddresses = ix.accounts.map((a) => accountKeys[a]);
    if (!node || node.depth !== ix.stackHeight || node.programId !== accountKeys[ix.programIdIndex]) return null;
    if (accountAddresses.some((a) => a === undefined)) return null;
    matched.push({ ...ix, accountAddresses: accountAddresses as Address[] });
  }
  return matched;
}

/** Adds the decoded error, instruction data and IDL decoding to a CPI tree. Pure; returns a new trace. */
export function annotateTrace(tree: Trace, details: TraceDetails): Trace {
  const nodes = tree.nodes.map((n) => ({ ...n }));
  const { status, instructions, accountKeys, inner, idls } = details;

  const failing = tree.failingNodeId === null ? undefined : nodes[tree.failingNodeId];
  if (failing && !status.success) failing.error = status.error;

  for (const node of nodes) {
    if (node.parent !== null) continue;
    const ix = instructions[node.instructionIndex];
    if (ix && ix.programId === node.programId) node.instruction = describe(ix.programId, ix.accounts, ix.data, idls);
  }

  if (inner) {
    for (const [index, list] of inner.entries()) {
      const cpis = nodes.filter((n) => n.parent !== null && n.instructionIndex === index);
      const matched = matchInner(cpis, list, accountKeys);
      if (!matched) continue;
      for (const [i, ix] of matched.entries()) {
        const node = cpis[i];
        if (node) node.instruction = describe(node.programId, ix.accountAddresses, ix.data, idls);
      }
    }
  }
  return { ...tree, nodes };
}
