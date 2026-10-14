import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  findSignAndSend,
  SIGN_AND_SEND_FEATURE,
  signAndSendWithWallet,
  SOLANA_MAINNET_CHAIN,
  walletErrorMessage,
  type SignAndSendInput,
} from "../lib/wallet-standard.ts";
import { OTHER, PAYER } from "./fixtures-simulation.ts";

const SIG_BYTES = new Uint8Array(64).fill(9);

function fakeAdapter(opts: { versions?: unknown[]; feature?: boolean; output?: unknown; reject?: unknown } = {}) {
  const calls: SignAndSendInput[][] = [];
  const thisValues: unknown[] = [];
  const account = { address: PAYER, publicKey: new Uint8Array(32), chains: [SOLANA_MAINNET_CHAIN], features: [] };
  const feature = {
    version: "1.0.0",
    supportedTransactionVersions: opts.versions ?? ["legacy", 0],
    async signAndSendTransaction(this: unknown, ...inputs: SignAndSendInput[]) {
      calls.push(inputs);
      thisValues.push(this);
      if (opts.reject !== undefined) throw opts.reject;
      return "output" in opts ? opts.output : [{ signature: SIG_BYTES }];
    },
  };
  const adapter = {
    name: "Fake",
    wallet: {
      accounts: [{ address: OTHER }, account],
      features: opts.feature === false ? { "solana:signTransaction": {} } : { [SIGN_AND_SEND_FEATURE]: feature },
    },
  };
  return { adapter, account, feature, calls, thisValues };
}

describe("findSignAndSend", () => {
  it("refuses a non-standard adapter", () => {
    expect(findSignAndSend({ name: "Legacy" }, PAYER, 0)).toMatchObject({ ok: false, reason: "not-standard" });
    expect(findSignAndSend(null, PAYER, 0)).toMatchObject({ ok: false, reason: "not-standard" });
  });

  it("refuses a wallet without signAndSendTransaction", () => {
    const r = findSignAndSend(fakeAdapter({ feature: false }).adapter, PAYER, 0);
    expect(r).toMatchObject({ ok: false, reason: "no-feature" });
    if (!r.ok) expect(r.message).toMatch(/never broadcasts/);
  });

  it("refuses an unsupported transaction version", () => {
    expect(findSignAndSend(fakeAdapter().adapter, PAYER, 1)).toMatchObject({ ok: false, reason: "unsupported-version" });
    expect(findSignAndSend(fakeAdapter({ versions: ["legacy", 0, 1] }).adapter, PAYER, 1)).toMatchObject({ ok: true });
  });

  it("refuses when the connected address is not a wallet account", () => {
    const third = "SysvarRent111111111111111111111111111111111";
    expect(findSignAndSend(fakeAdapter().adapter, third, 0)).toMatchObject({ ok: false, reason: "no-account" });
  });

  it("returns the wallet's own account object for the connected address", () => {
    const { adapter, account } = fakeAdapter();
    const r = findSignAndSend(adapter, PAYER, "legacy");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.account).toBe(account);
  });
});

describe("signAndSendWithWallet", () => {
  it("sends the bytes on mainnet and encodes the signature as base58", async () => {
    const { adapter, account, feature, calls, thisValues } = fakeAdapter();
    const lookup = findSignAndSend(adapter, PAYER, 0);
    if (!lookup.ok) throw new Error("expected a lookup");
    const tx = new Uint8Array([1, 2, 3]);
    expect(await signAndSendWithWallet(lookup, tx)).toBe(bs58.encode(SIG_BYTES));
    expect(calls).toEqual([[{ account, chain: "solana:mainnet", transaction: tx }]]);
    expect(calls[0]?.[0]?.account).toBe(account);
    expect(thisValues[0]).toBe(feature);
  });

  it.each([[[]], [[{ signature: new Uint8Array(10) }]], [[{ signature: "abc" }]], [null]])(
    "throws on an invalid wallet reply %#",
    async (output) => {
      const lookup = findSignAndSend(fakeAdapter({ output }).adapter, PAYER, 0);
      if (!lookup.ok) throw new Error("expected a lookup");
      await expect(signAndSendWithWallet(lookup, new Uint8Array([1]))).rejects.toThrow(/no valid signature/);
    },
  );

  it("propagates the wallet's rejection", async () => {
    const lookup = findSignAndSend(fakeAdapter({ reject: new Error("User rejected the request.") }).adapter, PAYER, 0);
    if (!lookup.ok) throw new Error("expected a lookup");
    await expect(signAndSendWithWallet(lookup, new Uint8Array([1]))).rejects.toThrow(/rejected/);
  });
});

describe("walletErrorMessage", () => {
  it.each([
    new Error("User rejected the request."),
    new Error("Transaction cancelled"),
    { code: 4001, message: "whatever" },
    { message: "Request denied by user" },
  ])("treats %j as a decline", (err) => {
    expect(walletErrorMessage(err)).toBe("You declined in your wallet.");
  });

  it("shows other wallet errors, trimmed", () => {
    expect(walletErrorMessage(new Error("Blockhash not found"))).toBe(
      "The wallet could not send the transaction: Blockhash not found",
    );
    expect(walletErrorMessage(new Error("x".repeat(500)))).toHaveLength(
      "The wallet could not send the transaction: ".length + 200,
    );
    expect(walletErrorMessage(undefined)).toBe("The wallet could not send the transaction.");
  });
});
