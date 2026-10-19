import { MAX_EVENT_TOKEN_DELTAS, type StreamEvent } from "@soltracer/shared/stream";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../decode/token-account.ts";

export interface MetaTokenBalance {
  accountIndex: number | bigint;
  mint: string;
  owner?: string | undefined;
  programId?: string | undefined;
  uiTokenAmount: { amount: string; decimals: number | bigint };
}

/** The parts of getTransaction's meta that balance changes come from. */
export interface BalanceMeta {
  preBalances: readonly (bigint | number)[];
  postBalances: readonly (bigint | number)[];
  preTokenBalances?: readonly MetaTokenBalance[] | null | undefined;
  postTokenBalances?: readonly MetaTokenBalance[] | null | undefined;
}

type Deltas = NonNullable<StreamEvent["deltas"]>;

const programKind = (id: string | undefined) =>
  id === TOKEN_PROGRAM ? ("token" as const) : id === TOKEN_2022_PROGRAM ? ("token-2022" as const) : null;

/**
 * The wallet's own balance changes in a transaction: its SOL (if it is one of the accounts and its
 * balance moved) and the token accounts it owns that changed, including ones created or closed.
 * `accountKeys` is the full account list in order (static keys, then loaded writable, then readonly).
 */
export function walletDeltas(wallet: string, accountKeys: readonly string[], meta: BalanceMeta): Deltas {
  const index = accountKeys.indexOf(wallet);
  const pre = index >= 0 ? meta.preBalances[index] : undefined;
  const post = index >= 0 ? meta.postBalances[index] : undefined;
  const sol =
    pre !== undefined && post !== undefined && BigInt(pre) !== BigInt(post)
      ? { address: wallet, pre: BigInt(pre).toString(), post: BigInt(post).toString(), delta: (BigInt(post) - BigInt(pre)).toString() }
      : null;

  const owned = (list: BalanceMeta["preTokenBalances"]) =>
    new Map((list ?? []).filter((b) => b.owner === wallet).map((b) => [Number(b.accountIndex), b]));
  const before = owned(meta.preTokenBalances);
  const after = owned(meta.postTokenBalances);
  const tokens: Deltas["tokens"] = [];
  for (const i of [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b)) {
    const b = before.get(i);
    const a = after.get(i);
    const info = a ?? b;
    const account = accountKeys[i];
    const program = programKind(info?.programId);
    if (!info || !account || !program) continue;
    const preAmount = BigInt(b?.uiTokenAmount.amount ?? "0");
    const postAmount = BigInt(a?.uiTokenAmount.amount ?? "0");
    if (preAmount === postAmount) continue;
    tokens.push({
      account,
      owner: wallet,
      mint: info.mint,
      program,
      decimals: Number(info.uiTokenAmount.decimals),
      pre: preAmount.toString(),
      post: postAmount.toString(),
      delta: (postAmount - preAmount).toString(),
    });
    if (tokens.length === MAX_EVENT_TOKEN_DELTAS) break;
  }
  return { sol, tokens };
}
