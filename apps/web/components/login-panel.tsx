"use client";

import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  buildLoginMessage,
  errorResponseSchema,
  nonceResponseSchema,
  verifyResponseSchema,
} from "@soltracer/shared";
import bs58 from "bs58";
import { AlertTriangle, ExternalLink, Loader2, LogIn, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

const SUPPORTED = new Map([
  ["Phantom", "https://phantom.com/download"],
  ["Solflare", "https://solflare.com/download"],
]);

const noopSubscribe = () => () => undefined;

/** False during SSR and hydration, true after: wallets are only detectable in the browser. */
function useIsClient(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

type Status = { kind: "idle" } | { kind: "busy"; label: string } | { kind: "error"; message: string };

function errorMessage(json: unknown, fallback: string): string {
  const err = errorResponseSchema.safeParse(json);
  return err.success ? err.data.message : fallback;
}

export function LoginPanel({ next }: { next: string }) {
  const { wallets, wallet, publicKey, connected, connecting, select, disconnect, signMessage } = useWallet();
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const isClient = useIsClient();

  const detected = wallets.filter(
    (w) => SUPPORTED.has(w.adapter.name) && w.readyState === WalletReadyState.Installed,
  );
  const missing = [...SUPPORTED].filter(([name]) => !detected.some((w) => w.adapter.name === name));

  async function signIn() {
    if (!publicKey || !signMessage) {
      setStatus({ kind: "error", message: "This wallet cannot sign messages." });
      return;
    }
    try {
      setStatus({ kind: "busy", label: "Requesting sign-in nonce…" });
      const nonceJson: unknown = await (await fetch("/api/auth/nonce", { cache: "no-store" })).json();
      const nonce = nonceResponseSchema.safeParse(nonceJson);
      if (!nonce.success) {
        setStatus({ kind: "error", message: errorMessage(nonceJson, "Could not start sign-in.") });
        return;
      }

      setStatus({ kind: "busy", label: "Approve the message in your wallet…" });
      const message = buildLoginMessage(window.location.host.toLowerCase(), nonce.data.nonce, nonce.data.issuedAt);
      const signature = await signMessage(new TextEncoder().encode(message));

      setStatus({ kind: "busy", label: "Verifying…" });
      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicKey: publicKey.toBase58(), signature: bs58.encode(signature), message }),
      });
      const verifyJson: unknown = await verifyRes.json();
      if (!verifyResponseSchema.safeParse(verifyJson).success) {
        setStatus({ kind: "error", message: errorMessage(verifyJson, "Sign-in failed.") });
        return;
      }
      router.replace(next);
      router.refresh();
    } catch (err) {
      const rejected = err instanceof Error && /reject|denied|cancel/i.test(err.message);
      setStatus({ kind: "error", message: rejected ? "You declined the signature request." : "Sign-in failed. Try again." });
    }
  }

  const busy = status.kind === "busy" || connecting;
  const button =
    "flex min-h-11 w-full items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors disabled:opacity-50";

  return (
    <div className="space-y-3">
      {connected && publicKey && wallet ? (
        <>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-neutral-800 px-3 py-2">
            <span className="text-xs text-neutral-400">{wallet.adapter.name}</span>
            <span className="truncate font-mono text-xs" title={publicKey.toBase58()}>
              {publicKey.toBase58()}
            </span>
          </div>
          <button type="button" onClick={() => void signIn()} disabled={busy} className={`${button} bg-violet-600 text-white hover:bg-violet-500`}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <LogIn className="size-4" aria-hidden />}
            Sign in
          </button>
          <button
            type="button"
            onClick={() => {
              setStatus({ kind: "idle" });
              void disconnect();
            }}
            disabled={busy}
            className={`${button} border border-neutral-800 text-neutral-300 hover:bg-neutral-800`}
          >
            <Unplug className="size-4" aria-hidden />
            Use a different wallet
          </button>
        </>
      ) : !isClient ? (
        <p className="flex min-h-11 items-center gap-2 text-sm text-neutral-400">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Looking for wallets…
        </p>
      ) : (
        <>
          {detected.map((w) => (
            <button
              key={w.adapter.name}
              type="button"
              onClick={() => {
                setStatus({ kind: "idle" });
                select(w.adapter.name as WalletName);
              }}
              disabled={busy}
              className={`${button} border border-neutral-800 hover:bg-neutral-800`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- wallet icons are data URIs */}
              <img src={w.adapter.icon} alt="" className="size-5" />
              Connect {w.adapter.name}
            </button>
          ))}
          {missing.map(([name, url]) => (
            <a
              key={name}
              href={url}
              target="_blank"
              rel="noreferrer"
              className={`${button} border border-dashed border-neutral-800 text-neutral-400 hover:bg-neutral-900`}
            >
              <ExternalLink className="size-4" aria-hidden />
              Install {name}
            </a>
          ))}
        </>
      )}

      <div aria-live="polite" className="min-h-5 text-sm">
        {status.kind === "busy" && <p className="text-neutral-400">{status.label}</p>}
        {status.kind === "error" && (
          <p role="alert" className="flex items-start gap-2 text-red-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{status.message}</span>
          </p>
        )}
      </div>
    </div>
  );
}
