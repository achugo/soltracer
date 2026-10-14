import { makeError, type ErrorResponse } from "@soltracer/shared/errors";
import { simulationResultSchema, type SimulationResult, type TxError } from "@soltracer/shared/simulation";
import { getBase64Encoder, type Address, type Base64EncodedWireTransaction, type TransactionMessageBytesBase64 } from "@solana/kit";
import type { SandboxCaches } from "../cache/types.ts";
import { builtinCustomError, SYSTEM_PROGRAM } from "../decode/builtin-errors.ts";
import { anchorIdlAddress } from "../decode/idl-address.ts";
import { IdlParseError, parseIdlErrors } from "../decode/idl.ts";
import { describeFailure, locateFailure } from "../decode/program-error.ts";
import { parseMintDecimals, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../decode/token-account.ts";
import { diffBalances, type AccountState } from "../diff/balances.ts";
import { getMultipleAccountsBatched } from "../rpc/accounts.ts";
import { RpcError, type RpcSession } from "../rpc/client.ts";
import { COMPUTE_BUDGET_PROGRAM, readComputeBudget } from "../tx/compute-budget.ts";
import { decodeTransactionInput } from "../tx/decode.ts";
import { LookupTableError, parseLookupTable, resolveAccounts } from "../tx/lookup-tables.ts";
import { instructionPrograms } from "../tx/programs.ts";
import { perInstructionUnits } from "./log-cu.ts";

/** Solana's fixed base fee per signature, used when getFeeForMessage cannot price the message. */
const LAMPORTS_PER_SIGNATURE = 5000n;
const NO_IDL_PROGRAMS = new Set<Address>([SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, COMPUTE_BUDGET_PROGRAM as Address]);

export type SimulateOutcome = { ok: true; result: SimulationResult } | { ok: false; status: number; error: ErrorResponse };

export interface SimulatorLog {
  info(obj: Record<string, unknown>, msg: string): void;
}

const base64 = getBase64Encoder();

function toState(account: { lamports: bigint; owner: Address; data: Uint8Array } | null): AccountState | null {
  return account ? { lamports: account.lamports, owner: account.owner, data: account.data } : null;
}

/**
 * A failed transaction changes no state except charging the fee payer, and simulateTransaction
 * returns no accounts for it; model that rather than reading missing accounts as closed.
 */
function feeOnlyPostState(
  writable: readonly Address[],
  pre: readonly (AccountState | null)[],
  feePayer: Address | undefined,
  fee: bigint,
): (AccountState | null)[] {
  return pre.map((state, i) =>
    state && writable[i] === feePayer ? { ...state, lamports: state.lamports > fee ? state.lamports - fee : 0n } : state,
  );
}

/** Loads the lookup tables a v0 transaction needs, from cache when the cached copy is long enough. */
async function loadTables(
  session: RpcSession,
  caches: SandboxCaches,
  lookups: readonly { table: Address; writableIndexes: number[]; readonlyIndexes: number[] }[],
): Promise<Map<Address, Address[]>> {
  if (lookups.length === 0) return new Map();
  const needed = new Map(lookups.map((l) => [l.table, Math.max(-1, ...l.writableIndexes, ...l.readonlyIndexes)]));
  const tables = await caches.lookupTables.getMany([...needed.keys()]);
  const missing = [...needed].filter(([table, maxIndex]) => (tables.get(table)?.length ?? 0) <= maxIndex).map(([t]) => t);
  if (missing.length === 0) return tables;

  const { slot, accounts } = await getMultipleAccountsBatched(session.rpc, missing);
  const fresh = missing.map((address, i) => {
    const account = accounts[i];
    if (!account) throw new LookupTableError(`Lookup table ${address} does not exist on-chain`);
    return { address, addresses: parseLookupTable(account.data), slot };
  });
  await caches.lookupTables.putMany(fresh);
  for (const t of fresh) tables.set(t.address, t.addresses);
  return tables;
}

/** Decimals for each mint, from cache or one batched read. */
async function loadDecimals(session: RpcSession, caches: SandboxCaches, mints: readonly Address[]) {
  const known = await caches.mints.getMany(mints);
  const missing = mints.filter((m) => !known.has(m));
  if (missing.length > 0) {
    const { accounts } = await getMultipleAccountsBatched(session.rpc, missing);
    const fresh = new Map<Address, { decimals: number; program: "token" | "token-2022" }>();
    missing.forEach((mint, i) => {
      const account = accounts[i];
      const decimals = account ? parseMintDecimals(account.owner, account.data) : null;
      if (account && decimals !== null) {
        fresh.set(mint, { decimals, program: account.owner === TOKEN_2022_PROGRAM ? "token-2022" : "token" });
      }
    });
    await caches.mints.putMany(fresh);
    for (const [k, v] of fresh) known.set(k, v);
  }
  return known;
}

/** IDL error table for a program that raised a custom error, from cache or one account read. */
async function loadIdlErrors(session: RpcSession, caches: SandboxCaches, program: Address) {
  const cached = await caches.idls.get(program);
  if (cached) return cached.found ? cached.errors : null;
  const account = await session.rpc.getAccountInfo(await anchorIdlAddress(program), { encoding: "base64" }).send();
  if (!account.value) {
    await caches.idls.put(program, { found: false });
    return null;
  }
  try {
    const errors = parseIdlErrors(new Uint8Array(base64.encode(account.value.data[0])));
    await caches.idls.put(program, { found: true, errors });
    return errors;
  } catch (err) {
    if (!(err instanceof IdlParseError)) throw err;
    await caches.idls.put(program, { found: false });
    return null;
  }
}

/**
 * Simulates a pasted transaction against current mainnet state through Helius.
 * Cold cost: up to 6 credits (tables, pre-state, simulate, fee, mints, IDL); warm: 3.
 */
export async function simulateWithRpc(
  input: string,
  session: RpcSession,
  caches: SandboxCaches,
  log?: SimulatorLog,
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
    const charged = typeof sim.value.err === "object" && sim.value.err !== null && "InstructionError" in sim.value.err;
    postStates = feeOnlyPostState(writable, preStates, accounts[0]?.address as Address | undefined, charged ? totalFee : 0n);
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

  let status: SimulationResult["status"] = { success: true };
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const site = locateFailure(sim.value.err, logs, instructionPrograms(tx, accounts));
    const failing = site.failingProgramId;
    const needsIdl =
      site.customCode !== null &&
      failing !== null &&
      !NO_IDL_PROGRAMS.has(failing) &&
      builtinCustomError(failing, site.customCode, false) === null;
    const idlErrors = needsIdl && failing ? await loadIdlErrors(session, caches, failing) : null;
    const error: TxError = describeFailure(sim.value.err, site, idlErrors && failing ? { program: failing, errors: idlErrors } : null);
    status = { success: false, error };
  }

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
    balances: {
      sol: changes.sol.map((c) => ({ address: c.address, pre: c.pre.toString(), post: c.post.toString(), delta: c.delta.toString() })),
      tokens: changes.tokens.flatMap((c) => {
        const info = decimals.get(c.mint);
        if (!info) return [];
        return [{
          account: c.account,
          owner: c.owner,
          mint: c.mint,
          program: c.program,
          decimals: info.decimals,
          pre: c.pre.toString(),
          post: c.post.toString(),
          delta: c.delta.toString(),
        }];
      }),
    },
    logs: [...(sim.value.logs ?? [])],
    slot: Number(sim.context.slot),
    credits: session.credits(),
    engine: "rpc",
    fallbackReason: null,
    perInstruction: perInstructionUnits(sim.value.logs ?? [], instructionPrograms(tx, accounts)),
    overrides: [],
    runId: null,
  };
  log?.info({ credits: result.credits, success: status.success, unitsConsumed: result.unitsConsumed }, "simulation done");
  return { ok: true, result: simulationResultSchema.parse(result) };
}
