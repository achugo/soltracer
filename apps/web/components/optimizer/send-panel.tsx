"use client";

import type { FeePreset, OptimizeResult } from "@soltracer/shared/optimize";
import { useWallet } from "@solana/wallet-adapter-react";
import { AlertTriangle, CircleCheck, ExternalLink, LoaderCircle, Send, Unplug } from "lucide-react";
import { useState } from "react";
import { base64ToBytes } from "@/lib/base64.ts";
import type { FeePayerCheck } from "@/lib/optimize-view.ts";
import { findSignAndSend, signAndSendWithWallet, walletErrorMessage } from "@/lib/wallet-standard.ts";
import { CopyButton } from "../copy-button.tsx";
import { walletButtonClass, WalletConnectButtons } from "../wallet-connect-buttons.tsx";
import { TxStatusCheck } from "./tx-status-check.tsx";

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; signature: string; preset: FeePreset }
  | { kind: "error"; message: string };

function Sent({ signature, preset }: { signature: string; preset: FeePreset }) {
  return (
    <div className="space-y-3 rounded-lg border border-green-900/70 bg-green-950/20 p-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-green-200">
        <CircleCheck className="size-4 shrink-0 text-green-400" aria-hidden />
        Sent by your wallet ({preset})
      </p>
      <p className="break-all font-mono text-xs text-neutral-100">{signature}</p>
      <div className="flex flex-wrap gap-2">
        <CopyButton value={signature} label="Copy signature" />
        <a
          href={`https://solscan.io/tx/${signature}`}
          target="_blank"
          rel="noreferrer"
          className="flex min-h-11 items-center gap-2 rounded-lg border border-neutral-700 px-3 text-sm text-neutral-100 hover:bg-neutral-900"
        >
          <ExternalLink className="size-4" aria-hidden />
          View on Solscan
        </a>
      </div>
      <TxStatusCheck signature={signature} />
    </div>
  );
}

/**
 * The wallet signs and broadcasts via Wallet Standard `solana:signAndSendTransaction`.
 * The browser never sends a transaction and has no RPC connection.
 */
export function SendPanel({ result, selected, feePayer }: { result: OptimizeResult; selected: FeePreset; feePayer: FeePayerCheck }) {
  const { wallet, publicKey, connected, disconnect } = useWallet();
  const [state, setState] = useState<SendState>({ kind: "idle" });

  if (state.kind === "sent") return <Sent signature={state.signature} preset={state.preset} />;

  if (!connected || !publicKey || !wallet) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-neutral-400">Connect the fee payer&apos;s wallet to sign and send.</p>
        <div className="grid gap-2 sm:max-w-sm">
          <WalletConnectButtons onSelect={() => setState({ kind: "idle" })} />
        </div>
      </div>
    );
  }

  const address = publicKey.toBase58();
  const version = result.before.version;
  const lookup = findSignAndSend(wallet.adapter, address, version);
  const blocked = feePayer.kind === "mismatch" ? "The connected wallet is not the fee payer." : lookup.ok ? null : lookup.message;
  const sending = state.kind === "sending";

  async function send() {
    // Look up again at click time: the wallet may have changed accounts since render.
    const current = wallet ? findSignAndSend(wallet.adapter, address, version) : null;
    if (!current?.ok) {
      setState({ kind: "error", message: current?.message ?? "Connect a wallet first." });
      return;
    }
    const bytes = base64ToBytes(result.presets[selected].tx);
    if (!bytes) {
      setState({ kind: "error", message: "The optimized transaction is not valid base64. Optimize again." });
      return;
    }
    setState({ kind: "sending" });
    try {
      const signature = await signAndSendWithWallet(current, bytes);
      setState({ kind: "sent", signature, preset: selected });
    } catch (err) {
      setState({ kind: "error", message: walletErrorMessage(err) });
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-800 px-3 py-2 text-sm">
        <span className="text-neutral-400">{wallet.adapter.name}</span>
        <span className="min-w-0 truncate font-mono text-xs" title={address}>{address}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || blocked !== null}
          className="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white hover:bg-violet-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
          {sending ? "Approve in your wallet…" : `Sign and send with wallet (${selected})`}
        </button>
        <button
          type="button"
          onClick={() => {
            setState({ kind: "idle" });
            void disconnect();
          }}
          disabled={sending}
          className={`${walletButtonClass} w-auto border border-neutral-800 text-neutral-300 hover:bg-neutral-800`}
        >
          <Unplug className="size-4" aria-hidden />
          Use a different wallet
        </button>
      </div>
      <div aria-live="polite" className="text-sm">
        {blocked && (
          <p className="flex items-start gap-2 text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>Can&apos;t send: {blocked}</span>
          </p>
        )}
        {state.kind === "error" && (
          <p role="alert" className="flex items-start gap-2 text-red-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{state.message}</span>
          </p>
        )}
      </div>
    </div>
  );
}
