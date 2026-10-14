import type { SimulationResult } from "@soltracer/shared/simulation";
import bs58 from "bs58";

/**
 * Wallet Standard `solana:signAndSendTransaction`, called directly so the wallet signs and broadcasts
 * through its own RPC. The browser never sends a transaction itself and there is no Connection.
 * Types are declared locally: the Wallet Standard packages are transitive, not direct, dependencies.
 */
export const SOLANA_MAINNET_CHAIN = "solana:mainnet";
export const SIGN_AND_SEND_FEATURE = "solana:signAndSendTransaction";

export interface StandardAccountLike {
  readonly address: string;
}

export interface SignAndSendInput {
  readonly account: StandardAccountLike;
  readonly chain: string;
  readonly transaction: Uint8Array;
}

export type SignAndSend = (input: SignAndSendInput) => Promise<unknown>;

export type SignAndSendLookup =
  | { ok: true; account: StandardAccountLike; signAndSend: SignAndSend }
  | { ok: false; reason: "not-standard" | "no-feature" | "no-account" | "unsupported-version"; message: string };

type TxVersion = SimulationResult["version"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Finds the signAndSend feature and the account to sign with, given a wallet adapter (from
 * `useWallet().wallet.adapter`). Pure over its input so it can be tested with a plain object.
 */
export function findSignAndSend(adapter: unknown, address: string, version: TxVersion): SignAndSendLookup {
  const wallet = isRecord(adapter) ? adapter.wallet : undefined;
  if (!isRecord(wallet) || !isRecord(wallet.features) || !Array.isArray(wallet.accounts)) {
    return {
      ok: false,
      reason: "not-standard",
      message: "This wallet does not support Wallet Standard, so it cannot sign and send here.",
    };
  }

  const feature = wallet.features[SIGN_AND_SEND_FEATURE];
  if (!isRecord(feature) || typeof feature.signAndSendTransaction !== "function") {
    return {
      ok: false,
      reason: "no-feature",
      message: "This wallet cannot sign and send transactions itself. SolTracer never broadcasts from the browser, so use a wallet that can (Phantom or Solflare).",
    };
  }

  const supported = feature.supportedTransactionVersions;
  if (Array.isArray(supported) && !supported.includes(version)) {
    const label = version === "legacy" ? "legacy" : `v${version}`;
    return {
      ok: false,
      reason: "unsupported-version",
      message: `This wallet does not support ${label} transactions.`,
    };
  }

  const account: unknown = wallet.accounts.find((a: unknown) => isRecord(a) && a.address === address);
  if (!isRecord(account) || typeof account.address !== "string") {
    return {
      ok: false,
      reason: "no-account",
      message: "The connected account was not found in the wallet. Reconnect the wallet and try again.",
    };
  }

  // Called as a method on the feature object, as the wallet adapter does, in case it relies on `this`.
  const method = feature.signAndSendTransaction as (...inputs: SignAndSendInput[]) => Promise<unknown>;
  const signAndSend: SignAndSend = (input) => method.call(feature, input);
  return { ok: true, account: account as unknown as StandardAccountLike, signAndSend };
}

/** Signs and sends through the wallet; returns the base58 signature. Throws on an invalid reply. */
export async function signAndSendWithWallet(
  lookup: Extract<SignAndSendLookup, { ok: true }>,
  transaction: Uint8Array,
): Promise<string> {
  const output = await lookup.signAndSend({ account: lookup.account, chain: SOLANA_MAINNET_CHAIN, transaction });
  const first: unknown = Array.isArray(output) ? output[0] : undefined;
  const signature = isRecord(first) ? first.signature : undefined;
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new Error("The wallet returned no valid signature.");
  }
  return bs58.encode(signature);
}

const DECLINED = /reject|denied|declin|cancel/i;

/** User-facing copy for a failed sign-and-send; a rejection in the wallet reads as a decline. */
export function walletErrorMessage(err: unknown): string {
  const code = isRecord(err) ? err.code : undefined;
  const message = err instanceof Error ? err.message : isRecord(err) && typeof err.message === "string" ? err.message : "";
  if (code === 4001 || DECLINED.test(message)) return "You declined in your wallet.";
  const detail = message.trim().slice(0, 200);
  return detail ? `The wallet could not send the transaction: ${detail}` : "The wallet could not send the transaction.";
}
