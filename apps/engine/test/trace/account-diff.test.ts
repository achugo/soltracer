import { readFileSync } from "node:fs";
import { accountDiffSchema, MAX_ACCOUNT_DIFFS, MAX_DIFF_RANGES, MAX_RANGE_BYTES_SHOWN } from "@soltracer/shared/trace";
import { address, getAddressDecoder, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { normalizeIdl } from "../../src/decode/idl-full.ts";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../../src/decode/token-account.ts";
import { diffBalances, type AccountState } from "../../src/diff/balances.ts";
import type { RpcCallRecord } from "../../src/rpc/client.ts";
import { parseRecordedJson } from "../../src/rpc/replay.ts";
import { diffAccounts } from "../../src/trace/account-diff.ts";
import type { SandboxFixtureName } from "../helpers/sandbox-fixtures.ts";

const SYSTEM = address("11111111111111111111111111111111");
const OWNER_PROGRAM = address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const A = address("Vote111111111111111111111111111111111111111");
const B = address("Stake11111111111111111111111111111111111111");
const noIdl = () => null;
const filled = (fill: number) => getAddressDecoder().decode(new Uint8Array(32).fill(fill));

type RecordedAccount = { lamports: bigint; owner: string; data: [string, string] } | null;
const toState = (a: RecordedAccount): AccountState | null =>
  a ? { lamports: BigInt(a.lamports), owner: address(a.owner), data: new Uint8Array(Buffer.from(a.data[0], "base64")) } : null;

/** The simulator's recorded pre-state (getMultipleAccounts) and post-state (simulateTransaction) of the writable accounts. */
function recordedStates(name: SandboxFixtureName) {
  const text = readFileSync(new URL(`../fixtures/sandbox/${name}.sim.json`, import.meta.url), "utf8");
  const { rpc } = parseRecordedJson(text) as { rpc: RpcCallRecord[] };
  const sim = rpc.find((r) => r.method === "simulateTransaction");
  const params = sim?.params as [string, { accounts: { addresses: string[] } }] | undefined;
  const addresses = (params?.[1].accounts.addresses ?? []).map((a) => address(a));
  const pre = rpc.find(
    (r) => r.method === "getMultipleAccounts" && JSON.stringify((r.params as [string[]])[0]) === JSON.stringify(addresses),
  );
  const preValues = (pre?.response as { result: { value: RecordedAccount[] } }).result.value;
  const postValues = (sim?.response as { result: { value: { accounts: RecordedAccount[] } } }).result.value.accounts;
  return { addresses, pre: preValues.map(toState), post: postValues.map(toState) };
}

/** Diffs that must also satisfy the shared contract. */
function diffChecked(...args: Parameters<typeof diffAccounts>) {
  const diffs = diffAccounts(...args);
  for (const d of diffs) expect(accountDiffSchema.safeParse(d).error).toBeUndefined();
  return diffs;
}

const state = (owner: Address, data: number[] | Uint8Array, lamports = 1_000_000n): AccountState => ({
  lamports,
  owner,
  data: Uint8Array.from(data),
});

describe("diffAccounts on recorded mainnet simulations", () => {
  it("jupiter-swap-alt: token amounts in the decoded diffs match the balance changes", () => {
    const { addresses, pre, post } = recordedStates("jupiter-swap-alt");
    const diffs = diffAccounts(addresses, pre, post, noIdl);
    for (const d of diffs) expect(accountDiffSchema.safeParse(d).error).toBeUndefined();

    const { tokens, sol } = diffBalances(addresses, pre, post);
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) {
      const d = diffs.find((x) => x.address === t.account);
      expect(d?.before?.decoded).toMatchObject({ type: "TokenAccount", fields: { mint: t.mint, owner: t.owner, amount: t.pre.toString() } });
      expect(d?.after?.decoded?.fields.amount).toBe(t.post.toString());
      // The amount is the u64 at offset 64 of the token account layout.
      expect(d?.changedRanges.some((r) => r.offset <= 64 && r.offset + r.length > 64)).toBe(true);
    }
    for (const s of sol) {
      const d = diffs.find((x) => x.address === s.address);
      expect([d?.before?.lamports, d?.after?.lamports]).toEqual([s.pre.toString(), s.post.toString()]);
    }
    const unchanged = addresses.filter((a, i) => JSON.stringify(pre[i], big) === JSON.stringify(post[i], big));
    for (const a of unchanged) expect(diffs.some((d) => d.address === a)).toBe(false);
  });

  it("sol-transfer: system accounts change lamports only", () => {
    const { addresses, pre, post } = recordedStates("sol-transfer");
    const diffs = diffAccounts(addresses, pre, post, noIdl);
    expect(diffs.length).toBeGreaterThan(0);
    for (const d of diffs) {
      expect(d.before?.decoded).toEqual({ layout: "system", type: "SystemAccount", fields: {} });
      expect(d.changedRanges).toEqual([]);
      expect(d.before?.lamports).not.toBe(d.after?.lamports);
    }
  });
});

const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? [...v] : v);

describe("diffAccounts layouts", () => {
  const u64 = (n: bigint) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return [...b];
  };
  const key = (fill: number) => Array<number>(32).fill(fill);
  const none = [0, 0, 0, 0];
  const some = [1, 0, 0, 0];

  const tokenAccount = (amount: bigint) => [
    ...key(1), // mint
    ...key(2), // owner
    ...u64(amount),
    ...some, ...key(3), // delegate
    1, // initialized
    ...none, ...u64(0n), // is_native
    ...u64(5n), // delegated amount
    ...none, ...key(0), // close authority
  ];
  const mint = (supply: bigint) => [...some, ...key(4), ...u64(supply), 6, 1, ...none, ...key(0)];

  it("decodes every field of a token account", () => {
    const [d] = diffChecked([A], [state(TOKEN_PROGRAM, tokenAccount(10n))], [state(TOKEN_PROGRAM, tokenAccount(7n))], noIdl);
    expect(d?.after?.decoded).toEqual({
      layout: "token",
      type: "TokenAccount",
      fields: {
        mint: filled(1),
        owner: filled(2),
        amount: "7",
        delegate: filled(3),
        state: "initialized",
        isNative: null,
        delegatedAmount: "5",
        closeAuthority: null,
      },
    });
    expect(d?.changedRanges).toEqual([{ offset: 64, length: 1, before: "0a", after: "07" }]);
  });

  it("decodes a Token-2022 account and a mint, and labels the program", () => {
    const ext = [...tokenAccount(1n), 2, 0, 0]; // account-type byte 2 at offset 165, then extensions
    const [t] = diffChecked([A], [state(TOKEN_2022_PROGRAM, ext)], [state(TOKEN_2022_PROGRAM, ext, 2n)], noIdl);
    expect(t?.after?.decoded).toMatchObject({ layout: "token-2022", type: "TokenAccount", fields: { amount: "1" } });

    const [m] = diffChecked([B], [state(TOKEN_PROGRAM, mint(100n))], [state(TOKEN_PROGRAM, mint(90n))], noIdl);
    expect(m?.after?.decoded).toEqual({
      layout: "mint",
      type: "Mint",
      fields: { mintAuthority: filled(4), supply: "90", decimals: 6, isInitialized: true, freezeAuthority: null },
    });
  });

  it("decodes an account of a program with an IDL", () => {
    const idl = normalizeIdl({
      instructions: [],
      accounts: [{ name: "Pool", discriminator: [9, 9, 9, 9, 9, 9, 9, 9] }],
      types: [{ name: "Pool", type: { kind: "struct", fields: [{ name: "fee_bps", type: "u16" }, { name: "reserve", type: "u64" }] } }],
    });
    const pool = (reserve: bigint) => [9, 9, 9, 9, 9, 9, 9, 9, 30, 0, ...u64(reserve)];
    const idlFor = (owner: Address) => (owner === OWNER_PROGRAM ? idl : null);
    const [d] = diffChecked([A], [state(OWNER_PROGRAM, pool(1000n))], [state(OWNER_PROGRAM, pool(1500n))], idlFor);
    expect(d?.before?.decoded).toEqual({ layout: "idl", type: "Pool", fields: { fee_bps: 30, reserve: "1000" } });
    expect(d?.after?.decoded?.fields.reserve).toBe("1500");
  });

  it("falls back to raw byte ranges for an unknown layout", () => {
    const [d] = diffChecked([A], [state(OWNER_PROGRAM, [1, 2, 3, 4, 5, 6])], [state(OWNER_PROGRAM, [1, 9, 9, 4, 5, 7])], noIdl);
    expect(d?.before?.decoded).toBeNull();
    expect(d?.changedRanges).toEqual([
      { offset: 1, length: 2, before: "0203", after: "0909" },
      { offset: 5, length: 1, before: "06", after: "07" },
    ]);
  });
});

describe("diffAccounts lifecycle and caps", () => {
  it("a created account has no before; a closed one has no after", () => {
    const [created] = diffChecked([A], [null], [state(OWNER_PROGRAM, [1, 2])], noIdl);
    expect(created).toMatchObject({ before: null, changedRanges: [{ offset: 0, length: 2, before: "", after: "0102" }] });
    const [closed] = diffChecked([A], [state(SYSTEM, [], 5n)], [null], noIdl);
    expect(closed).toMatchObject({ after: null, changedRanges: [] });
    // Simulators may return a closed account zeroed rather than missing.
    const [zeroed] = diffChecked([A], [state(OWNER_PROGRAM, [1, 2], 5n)], [state(SYSTEM, [], 0n)], noIdl);
    expect(zeroed).toMatchObject({ after: null, changedRanges: [{ offset: 0, length: 2, before: "0102", after: "" }] });
    expect(diffChecked([A], [null], [null], noIdl)).toEqual([]);
  });

  it("a resized account: the new tail shows on one side only", () => {
    const [d] = diffChecked([A], [state(OWNER_PROGRAM, [1, 2])], [state(OWNER_PROGRAM, [1, 2, 3, 4])], noIdl);
    expect(d?.changedRanges).toEqual([{ offset: 2, length: 2, before: "", after: "0304" }]);
    expect([d?.before?.dataLength, d?.after?.dataLength]).toEqual([2, 4]);
  });

  it("an owner change alone is a diff", () => {
    const [d] = diffChecked([A], [state(SYSTEM, [])], [state(OWNER_PROGRAM, [])], noIdl);
    expect([d?.before?.owner, d?.after?.owner]).toEqual([SYSTEM, OWNER_PROGRAM]);
  });

  it(`lists at most ${MAX_DIFF_RANGES} ranges and ${MAX_RANGE_BYTES_SHOWN} bytes per side`, () => {
    const before = new Uint8Array(1000);
    const after = before.map((_, i) => (i % 2 === 0 ? 1 : 0));
    const [many] = diffChecked([A], [state(OWNER_PROGRAM, before)], [state(OWNER_PROGRAM, after)], noIdl);
    expect(many?.changedRanges).toHaveLength(MAX_DIFF_RANGES);
    expect(many?.rangesTruncated).toBe(true);

    const [long] = diffChecked([A], [state(OWNER_PROGRAM, before)], [state(OWNER_PROGRAM, new Uint8Array(1000).fill(7))], noIdl);
    expect(long?.changedRanges).toEqual([{ offset: 0, length: 1000, before: "00".repeat(MAX_RANGE_BYTES_SHOWN), after: "07".repeat(MAX_RANGE_BYTES_SHOWN) }]);
    expect(accountDiffSchema.safeParse(long).success).toBe(true);
  });

  it(`keeps at most ${MAX_ACCOUNT_DIFFS} accounts`, () => {
    const n = MAX_ACCOUNT_DIFFS + 5;
    const addresses = Array.from({ length: n }, () => A);
    const diffs = diffChecked(addresses, addresses.map(() => state(SYSTEM, [], 1n)), addresses.map(() => state(SYSTEM, [], 2n)), noIdl);
    expect(diffs).toHaveLength(MAX_ACCOUNT_DIFFS);
  });

  it("rejects lists that don't line up", () => {
    expect(() => diffAccounts([A, B], [null], [null], noIdl)).toThrow();
  });
});
