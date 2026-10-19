import { makeError } from "@soltracer/shared/errors";
import { simulationResultSchema, type Override, type SimulationResult } from "@soltracer/shared/simulation";
import type { Address } from "@solana/kit";
import type { SandboxCaches } from "../../cache/types.ts";
import { parseMintDecimals, TOKEN_2022_PROGRAM } from "../../decode/token-account.ts";
import { diffBalances, type AccountState } from "../../diff/balances.ts";
import type { RpcSession } from "../../rpc/client.ts";
import { readComputeBudget } from "../../tx/compute-budget.ts";
import { decodeTransactionInput } from "../../tx/decode.ts";
import { LookupTableError, resolveAccounts } from "../../tx/lookup-tables.ts";
import { instructionPrograms } from "../../tx/programs.ts";
import {
  decodeStatus,
  feeOnlyPostState,
  feeWasCharged,
  formatBalances,
  LAMPORTS_PER_SIGNATURE,
  loadDecimals,
  loadTables,
  toState,
  type SimulateOutcome,
  type SimulatorLog,
} from "../common.ts";
import { perInstructionUnits } from "../log-cu.ts";
import { loadState, LocalLoadError, type ProgramCache } from "./loader.ts";
import { applyOverrides, OverrideError } from "./overrides.ts";
import { runLocal } from "./runner.ts";

/**
 * Runs a pasted transaction in LiteSVM against mainnet state loaded now, with optional overrides.
 * Throws LocalLoadError when state or programs can't be loaded or LiteSVM rejects them, so the
 * caller can fall back to rpc (only when there are no overrides).
 */
export async function simulateLocally(
  input: string,
  overrides: readonly Override[],
  session: RpcSession,
  caches: SandboxCaches,
  programCache: ProgramCache,
  log?: SimulatorLog,
): Promise<SimulateOutcome> {
  const decoded = decodeTransactionInput(input);
  if (!decoded.ok) return { ok: false, status: 400, error: decoded.error };
  const tx = decoded.tx;

  let accounts;
  try {
    accounts = resolveAccounts(tx, await loadTables(session, caches, tx.lookups));
  } catch (err) {
    if (err instanceof LookupTableError) return { ok: false, status: 400, error: makeError("VALIDATION_ERROR", err.message) };
    throw err;
  }
  const computeBudget = readComputeBudget(tx, accounts);
  const keys = [...new Set([...accounts.map((a) => a.address as Address), ...tx.lookups.map((l) => l.table)])];
  const state = await loadState(keys, session, programCache);

  let installed;
  try {
    installed = await applyOverrides(state.accounts, overrides);
  } catch (err) {
    if (err instanceof OverrideError) return { ok: false, status: 400, error: makeError("VALIDATION_ERROR", err.message) };
    throw err;
  }

  let run;
  try {
    run = runLocal({ wire: new Uint8Array(Buffer.from(tx.wireBase64, "base64")), accounts: installed, programs: state.programs, clock: state.clock });
  } catch (err) {
    throw new LocalLoadError(`LiteSVM could not run this transaction: ${err instanceof Error ? err.message : String(err)}`);
  }

  const priority = BigInt(computeBudget.priorityFeeLamports);
  const baseFee = LAMPORTS_PER_SIGNATURE * BigInt(tx.numSignatures);
  const totalFee = baseFee + priority;

  // Deltas are measured from the state the run started from: mainnet plus the overrides.
  const writable = [...new Set(accounts.filter((a) => a.writable).map((a) => a.address as Address))];
  const preStates = writable.map((a) => toState(installed.get(a) ?? null));
  const postStates: (AccountState | null)[] = run.err
    ? feeOnlyPostState(writable, preStates, accounts[0]?.address as Address | undefined, feeWasCharged(run.err) ? totalFee : 0n)
    : writable.map((a, i) => run.post.get(a) ?? preStates[i] ?? null);
  const changes = diffBalances(writable, preStates, postStates);

  // Mint decimals: from the loaded state when present, otherwise the cache or one read.
  const local = new Map<Address, { decimals: number; program: "token" | "token-2022" }>();
  for (const mint of changes.mints) {
    const account = installed.get(mint);
    const decimals = account ? parseMintDecimals(account.owner, account.data) : null;
    if (account && decimals !== null) local.set(mint, { decimals, program: account.owner === TOKEN_2022_PROGRAM ? "token-2022" : "token" });
  }
  const missing = changes.mints.filter((m) => !local.has(m));
  const decimals = new Map([...local, ...(missing.length > 0 ? await loadDecimals(session, caches, missing) : [])]);

  const programs = instructionPrograms(tx, accounts);
  const status = await decodeStatus(run.err, run.logs, programs, session, caches);

  const result: SimulationResult = {
    ok: true,
    encoding: tx.encoding,
    version: tx.version,
    signed: tx.signed,
    accounts,
    computeBudget,
    unitsConsumed: Number(run.unitsConsumed),
    status,
    fee: { baseLamports: baseFee.toString(), priorityLamports: priority.toString(), totalLamports: totalFee.toString() },
    balances: formatBalances(changes, decimals),
    logs: run.logs,
    slot: Number(state.clock.slot),
    credits: session.credits(),
    engine: "local",
    fallbackReason: null,
    perInstruction: perInstructionUnits(run.logs, programs),
    overrides: [...overrides],
    runId: null,
  };
  log?.info({ credits: result.credits, success: status.success, programs: state.programs.length }, "local simulation done");
  return { ok: true, result: simulationResultSchema.parse(result) };
}
