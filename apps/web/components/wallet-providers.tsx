"use client";

import { WalletProvider } from "@solana/wallet-adapter-react";
import type { ReactNode } from "react";

/**
 * No ConnectionProvider: the browser never talks to an RPC node.
 * No legacy adapters: Phantom and Solflare register through Wallet Standard.
 */
export function WalletProviders({ children }: { children: ReactNode }) {
  return (
    <WalletProvider wallets={[]} autoConnect>
      {children}
    </WalletProvider>
  );
}
