import { makeError } from "@soltracer/shared/errors";
import { simulationResultSchema, type SimulationResult } from "@soltracer/shared/simulation";
import type { Address, Base64EncodedWireTransaction, TransactionMessageBytesBase64 } from "@solana/kit";
import type { SandboxCaches } from "../cache/types.ts";
import { diffBalances, type AccountState } from "../diff/balances.ts";
import { getMultipleAccountsBatched } from "../rpc/accounts.ts";
import { RpcError, type RpcSession } from "../rpc/client.ts";
import { readComputeBudget } from "../tx/compute-budget.ts";
import { decodeTransactionInput } from "../tx/decode.ts";
import { LookupTableError, resolveAccounts } from "../tx/lookup-tables.ts";
import { instructionPrograms } from "../tx/programs.ts";
import { diffAccounts } from "../trace/account-diff.ts";
import { traceRun } from "../trace/run-trace.ts";
import { diffsWithoutInvalidDecoding } from "../trace/schema-safe.ts";
import {
  base64,
  feeOnlyPostState,
  feeWasCharged,
  formatBalances,
  LAMPORTS_PER_SIGNATURE,
  loadDecimals,
  loadTables,
  toState,
  type IdlMode,
  type SimulateOutcome,
  type SimulatorLog,
} from "./common.ts";
import { perInstructionUnits } from "./log-cu.ts";

export type { SimulateOutcome, SimulatorLog };


/**
 * Simulates a pasted transaction against current mainnet state through Helius.
 * Cold cost: up to 6 credits (tables, pre-state, simulate, fee, mints, IDL); warm: 3.
 */
export async function simulateWithRpc(
  input: string,
  session: RpcSession,
  caches: SandboxCaches,
  log?: SimulatorLog,
  /** "fetch" reads IDLs for decoding (sandbox runs); "cached" uses only cached ones (optimizer checks, replays). */
  idlMode: IdlMode = "cached",
): Promise<SimulateOutcome> {
  const decoded = decodeTransactionInput(input);
  if (!decoded.ok) return { ok: false, status: 400, error: decoded.error };
  const tx = decoded.tx;

  let accounts;
  try {
    accounts = resolveAccounts(tx, await loadTables(session, caches, tx.lookups));
  } catch (err) {
    if (err instanceof LookupTableError) {
      return { ok: false, status: 400, error: makeError("VALIDATION_ERROR", err.message) };
    }
    throw err;
  }
  const computeBudget = readComputeBudget(tx, accounts);
  const writable = [...new Set(accounts.filter((a) => a.writable).map((a) => a.address as Address))];

  const pre = await getMultipleAccountsBatched(session.rpc, writable);

  const sim = await session.rpc
    .simulateTransaction(tx.wireBase64 as Base64EncodedWireTransaction, {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
      accounts: { addresses: writable, encoding: "base64" },
    })
    .send();

  const feeResponse = await session.rpc
    .getFeeForMessage(tx.messageBase64 as TransactionMessageBytesBase64, { commitment: "confirmed" })
    .send();

  // getFeeForMessage includes the priority fee; it returns null once the blockhash has expired.
  const priority = BigInt(computeBudget.priorityFeeLamports);
  const baseFee =
    feeResponse.value !== null && feeResponse.value >= priority
      ? feeResponse.value - priority
      : LAMPORTS_PER_SIGNATURE * BigInt(tx.numSignatures);
  const totalFee = baseFee + priority;
  log?.info({ feeSource: feeResponse.value === null ? "per-signature" : "getFeeForMessage" }, "simulation fee");

  const preStates = pre.accounts.map(toState);
  const simAccounts = sim.value.accounts;
  let postStates: (AccountState | null)[];
  if (sim.value.err) {
    // Fees are charged only once the transaction starts executing (an instruction error);
    // fee-validation and loading failures leave every balance untouched.
    postStates = feeOnlyPostState(writable, preStates, accounts[0]?.address as Address | undefined, feeWasCharged(sim.value.err) ? totalFee : 0n);
  } else {
    if (!simAccounts || simAccounts.length !== writable.length) {
      throw new RpcError(
        "RPC_ERROR",
        "simulateTransaction",
        `simulateTransaction returned ${simAccounts?.length ?? "no"} accounts for ${writable.length} requested`,
      );
    }
    postStates = simAccounts.map((a) =>
      a ? toState({ lamports: a.lamports, owner: a.owner, data: new Uint8Array(base64.encode(a.data[0])) }) : null,
    );
  }
  const changes = diffBalances(writable, preStates, postStates);
  const decimals = await loadDecimals(session, caches, changes.mints);

  // rpc runs see only top-level instruction data: inner instructions aren't requested from simulateTransaction.
  const { status, trace, idls } = await traceRun({
    err: sim.value.err,
    logs: sim.value.logs ?? [],
    tx,
    accounts,
    inner: null,
    session,
    caches,
    idlMode,
  });

  const result: SimulationResult = {
    ok: true,
    encoding: tx.encoding,
    version: tx.version,
    signed: tx.signed,
    accounts,
    computeBudget,
    unitsConsumed: Number(sim.value.unitsConsumed ?? 0n),
    status,
    fee: {
      baseLamports: baseFee.toString(),
      priorityLamports: priority.toString(),
      totalLamports: totalFee.toString(),
    },
    balances: formatBalances(changes, decimals),
    logs: [...(sim.value.logs ?? [])],
    slot: Number(sim.context.slot),
    credits: session.credits(),
    engine: "rpc",
    fallbackReason: null,
    perInstruction: perInstructionUnits(sim.value.logs ?? [], instructionPrograms(tx, accounts)),
    overrides: [],
    trace,
    accountDiffs: diffsWithoutInvalidDecoding(diffAccounts(writable, preStates, postStates, (owner) => idls.get(owner) ?? null)),
    runId: null,
  };
  log?.info({ credits: result.credits, success: status.success, unitsConsumed: result.unitsConsumed }, "simulation done");
  return { ok: true, result: simulationResultSchema.parse(result) };
}
