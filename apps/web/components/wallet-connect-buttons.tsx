"use client";

import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import { ExternalLink, Loader2 } from "lucide-react";
import { useIsClient } from "@/lib/use-is-client.ts";

const SUPPORTED = new Map([
  ["Phantom", "https://phantom.com/download"],
  ["Solflare", "https://solflare.com/download"],
]);

export const walletButtonClass =
  "flex min-h-11 w-full items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors disabled:opacity-50";

/** Connect buttons for detected Phantom/Solflare, and install links for the missing ones. */
export function WalletConnectButtons({ disabled = false, onSelect }: { disabled?: boolean; onSelect?: () => void }) {
  const { wallets, connecting, select } = useWallet();
  const isClient = useIsClient();

  if (!isClient) {
    return (
      <p className="flex min-h-11 items-center gap-2 text-sm text-neutral-400">
        <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
        Looking for wallets…
      </p>
    );
  }

  const detected = wallets.filter(
    (w) => SUPPORTED.has(w.adapter.name) && w.readyState === WalletReadyState.Installed,
  );
  const missing = [...SUPPORTED].filter(([name]) => !detected.some((w) => w.adapter.name === name));

  return (
    <>
      {detected.map((w) => (
        <button
          key={w.adapter.name}
          type="button"
          onClick={() => {
            onSelect?.();
            select(w.adapter.name as WalletName);
          }}
          disabled={disabled || connecting}
          className={`${walletButtonClass} border border-neutral-800 hover:bg-neutral-800`}
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
          className={`${walletButtonClass} border border-dashed border-neutral-800 text-neutral-400 hover:bg-neutral-900`}
        >
          <ExternalLink className="size-4" aria-hidden />
          Install {name}
        </a>
      ))}
    </>
  );
}
