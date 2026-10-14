import {
  MAX_ACCOUNT_DIFFS,
  MAX_DIFF_RANGES,
  MAX_RANGE_BYTES_SHOWN,
  type AccountDiff,
  type AccountSide,
  type ChangedRange,
  type DecodedAccount,
} from "@soltracer/shared/trace";
import type { Address } from "@solana/kit";
import { decodeIdlAccount, type NormalizedIdl } from "../decode/idl-full.ts";
import { decodeMintFields, decodeTokenAccountFields } from "../decode/token-account.ts";
import type { AccountState } from "../diff/balances.ts";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** Field names for account data: known layouts first, then the owner's IDL; null renders raw. */
function decodeAccount(state: AccountState, idlFor: (owner: Address) => NormalizedIdl | null): DecodedAccount | null {
  if (state.owner === SYSTEM_PROGRAM && state.data.length === 0) return { layout: "system", type: "SystemAccount", fields: {} };
  const token = decodeTokenAccountFields(state.owner, state.data);
  if (token) return { layout: token.program, type: "TokenAccount", fields: token.fields };
  const mint = decodeMintFields(state.owner, state.data);
  if (mint) return { layout: "mint", type: "Mint", fields: mint };
  const idl = idlFor(state.owner);
  const decoded = idl && decodeIdlAccount(idl, state.data);
  return decoded ? { layout: "idl", ...decoded } : null;
}

function side(state: AccountState | null, idlFor: (owner: Address) => NormalizedIdl | null): AccountSide | null {
  if (!state) return null;
  return {
    lamports: state.lamports.toString(),
    owner: state.owner,
    dataLength: state.data.length,
    decoded: decodeAccount(state, idlFor),
  };
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes.subarray(0, MAX_RANGE_BYTES_SHOWN)).toString("hex");

/** Runs of bytes that differ; past one side's end every byte counts as changed and that side shows nothing. */
export function changedRanges(before: Uint8Array, after: Uint8Array): { ranges: ChangedRange[]; truncated: boolean } {
  const ranges: ChangedRange[] = [];
  const common = Math.min(before.length, after.length);
  const end = Math.max(before.length, after.length);
  for (let i = 0; i < end; i++) {
    if (i < common && before[i] === after[i]) continue;
    let j = i;
    while (j < end && (j >= common || before[j] !== after[j])) j++;
    if (ranges.length === MAX_DIFF_RANGES) return { ranges, truncated: true };
    ranges.push({
      offset: i,
      length: j - i,
      before: hex(before.subarray(Math.min(i, before.length), Math.min(j, before.length))),
      after: hex(after.subarray(Math.min(i, after.length), Math.min(j, after.length))),
    });
    i = j;
  }
  return { ranges, truncated: false };
}

function sameState(a: AccountState, b: AccountState): boolean {
  return a.lamports === b.lamports && a.owner === b.owner && Buffer.compare(a.data, b.data) === 0;
}

/** An account with no lamports doesn't exist: the runtime drops it, and simulators may return it zeroed. */
const existing = (state: AccountState | null | undefined) => (state && state.lamports > 0n ? state : null);

/**
 * Before/after diffs of the accounts that changed (created, closed, or any of lamports, owner or
 * data), in the order given. Data is decoded by known layout or the owner's IDL, with the changed
 * byte ranges always listed. At most MAX_ACCOUNT_DIFFS accounts.
 */
export function diffAccounts(
  addresses: readonly Address[],
  pre: readonly (AccountState | null)[],
  post: readonly (AccountState | null)[],
  idlFor: (owner: Address) => NormalizedIdl | null,
): AccountDiff[] {
  if (pre.length !== addresses.length || post.length !== addresses.length) {
    throw new Error("Pre and post account lists must line up with the addresses");
  }
  const diffs: AccountDiff[] = [];
  for (const [i, address] of addresses.entries()) {
    if (diffs.length === MAX_ACCOUNT_DIFFS) break;
    const before = existing(pre[i]);
    const after = existing(post[i]);
    if (before === null && after === null) continue;
    if (before && after && sameState(before, after)) continue;
    const { ranges, truncated } = changedRanges(before?.data ?? new Uint8Array(0), after?.data ?? new Uint8Array(0));
    diffs.push({ address, before: side(before, idlFor), after: side(after, idlFor), changedRanges: ranges, rangesTruncated: truncated });
  }
  return diffs;
}
