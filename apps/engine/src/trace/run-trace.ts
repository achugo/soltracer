import type { AccountRef, SimulationResult } from "@soltracer/shared/simulation";
import type { Trace } from "@soltracer/shared/trace";
import type { Address } from "@solana/kit";
import type { SandboxCaches } from "../cache/types.ts";
import type { NormalizedIdl } from "../decode/idl-full.ts";
import type { RpcSession } from "../rpc/client.ts";
import { decodeStatus, loadDecodingIdls, type IdlMode } from "../sim/common.ts";
import type { InnerInstruction } from "../sim/local/runner.ts";
import type { DecodedTransaction } from "../tx/decode.ts";
import { topLevelInstructions } from "../tx/instructions.ts";
import { annotateTrace } from "./annotate.ts";
import { withoutInvalidDecoding } from "./schema-safe.ts";
import { buildCpiTree } from "./cpi-tree.ts";

/** Top-level instruction an RPC-shaped error names, if any (kit's transport parses integers as BigInt). */
export function failedInstructionOf(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("InstructionError" in err)) return null;
  const detail = (err as { InstructionError: unknown }).InstructionError;
  const index: unknown = Array.isArray(detail) ? detail[0] : undefined;
  if (typeof index === "bigint") return index >= 0n && index <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(index) : null;
  return typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? index : null;
}

/**
 * A run's status and trace. In "fetch" mode the IDLs of every program in the tree are read first
 * (one batched call for the uncached ones), so the error decoder finds the failing program's in cache.
 */
export async function traceRun(input: {
  err: unknown;
  logs: readonly string[];
  tx: DecodedTransaction;
  accounts: readonly AccountRef[];
  /** CPIs per top-level instruction (local runs); null for rpc runs. */
  inner: readonly (readonly InnerInstruction[])[] | null;
  session: RpcSession;
  caches: SandboxCaches;
  idlMode: IdlMode;
}): Promise<{ status: SimulationResult["status"]; trace: Trace; idls: Map<string, NormalizedIdl> }> {
  const { err, logs, tx, accounts, inner, session, caches, idlMode } = input;
  const instructions = topLevelInstructions(tx, accounts);
  const programs = instructions.map((ix) => ix.programId);
  const tree = buildCpiTree({ logs, programs, failed: err !== null && err !== undefined, failedInstruction: failedInstructionOf(err) });
  const treePrograms = tree.nodes.map((n) => n.programId);

  if (idlMode === "fetch") await loadDecodingIdls(session, caches, treePrograms, "fetch");
  const status = await decodeStatus(err, logs, programs, session, caches);
  const idls = await loadDecodingIdls(session, caches, treePrograms, "cached");

  const trace = withoutInvalidDecoding(annotateTrace(tree, {
    status,
    instructions,
    accountKeys: accounts.map((a) => a.address as Address),
    inner,
    idls,
  }));
  return { status, trace, idls };
}
