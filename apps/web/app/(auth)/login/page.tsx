import { Activity } from "lucide-react";
import { LoginPanel } from "@/components/login-panel.tsx";
import { WalletProviders } from "@/components/wallet-providers.tsx";
import { safeNextPath } from "@/lib/route-guard.ts";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-900/60 p-6">
        <div className="mb-6 flex items-center gap-2">
          <Activity className="size-6 text-violet-400" aria-hidden />
          <h1 className="text-lg font-semibold">SolTracer</h1>
        </div>
        <p className="mb-6 text-sm text-neutral-400">
          Sign in by signing a message with an allowlisted wallet. Nothing is sent on-chain.
        </p>
        <WalletProviders>
          <LoginPanel next={safeNextPath(typeof next === "string" ? next : null)} />
        </WalletProviders>
      </div>
    </main>
  );
}
