import type { ErrorResponse } from "@soltracer/shared/errors";
import type { SimulationResult, TxError } from "@soltracer/shared/simulation";
import { getBase64Encoder, type Address } from "@solana/kit";
import type { SandboxCaches } from "../cache/types.ts";
import { builtinCustomError, SYSTEM_PROGRAM } from "../decode/builtin-errors.ts";
import { anchorIdlAddress } from "../decode/idl-address.ts";
import { IdlParseError, parseIdlErrors } from "../decode/idl.ts";
import { describeFailure, locateFailure } from "../decode/program-error.ts";
import { parseMintDecimals, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../decode/token-account.ts";
import type { AccountState, SolChange, TokenChange } from "../diff/balances.ts";
import { getMultipleAccountsBatched } from "../rpc/accounts.ts";
import type { RpcSession } from "../rpc/client.ts";
import { COMPUTE_BUDGET_PROGRAM } from "../tx/compute-budget.ts";
import { LookupTableError, parseLookupTable } from "../tx/lookup-tables.ts";

/** Solana's fixed base fee per signature, used when getFeeForMessage cannot price the message. */
export const LAMPORTS_PER_SIGNATURE = 5000n;
const NO_IDL_PROGRAMS = new Set<Address>([SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, COMPUTE_BUDGET_PROGRAM as Address]);

export type SimulateOutcome = { ok: true; result: SimulationResult } | { ok: false; status: number; error: ErrorResponse };

export interface SimulatorLog {
  info(obj: Record<string, unknown>, msg: string): void;
}

export const base64 = getBase64Encoder();

export function toState(account: { lamports: bigint; owner: Address; data: Uint8Array } | null): AccountState | null {
  return account ? { lamports: account.lamports, owner: account.owner, data: account.data } : null;
}

/**
 * A failed transaction changes no state except charging the fee payer, and simulateTransaction
 * returns no accounts for it; model that rather than reading missing accounts as closed.
 */
export function feeOnlyPostState(
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
export async function loadTables(
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
export async function loadDecimals(session: RpcSession, caches: SandboxCaches, mints: readonly Address[]) {
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
export async function loadIdlErrors(session: RpcSession, caches: SandboxCaches, program: Address) {
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


/** Status of a run: success, or the located and decoded error (fetching the IDL only if needed). */
export async function decodeStatus(
  err: unknown,
  logs: readonly string[],
  programs: readonly Address[],
  session: RpcSession,
  caches: SandboxCaches,
): Promise<SimulationResult["status"]> {
  if (!err) return { success: true };
  const site = locateFailure(err, logs, programs);
  const failing = site.failingProgramId;
  const needsIdl =
    site.customCode !== null &&
    failing !== null &&
    !NO_IDL_PROGRAMS.has(failing) &&
    builtinCustomError(failing, site.customCode, false) === null;
  const idlErrors = needsIdl && failing ? await loadIdlErrors(session, caches, failing) : null;
  const error: TxError = describeFailure(err, site, idlErrors && failing ? { program: failing, errors: idlErrors } : null);
  return { success: false, error };
}

/** Whether an RPC-shaped error was raised while executing (so the fee was charged). */
export function feeWasCharged(err: unknown): boolean {
  return typeof err === "object" && err !== null && "InstructionError" in err;
}

/** Balance changes in the shared contract's string form; tokens without known decimals are left out. */
export function formatBalances(
  changes: { sol: SolChange[]; tokens: TokenChange[] },
  decimals: ReadonlyMap<Address, { decimals: number }>,
): SimulationResult["balances"] {
  return {
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
  };
}

