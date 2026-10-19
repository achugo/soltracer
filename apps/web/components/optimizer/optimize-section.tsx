"use client";

import { LoaderCircle, Rocket } from "lucide-react";
import { useOptimize } from "@/lib/use-optimize.ts";
import { ApiErrorAlert } from "../sandbox/api-error-alert.tsx";
import { WalletProviders } from "../wallet-providers.tsx";
import { OptimizerPanel } from "./optimizer-panel.tsx";

/** Wallet context stays mounted across re-runs so the connection survives "Optimize again". */
export function OptimizeSection({ tx }: { tx: string }) {
  return (
    <WalletProviders>
      <Optimize tx={tx} />
    </WalletProviders>
  );
}

/** Runs only on click: each optimize spends Helius credits, so it is never automatic or retried. */
function Optimize({ tx }: { tx: string }) {
  const optimize = useOptimize();
  const outcome = optimize.data;
  const run = () => optimize.mutate({ tx, preset: "p75" });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={optimize.isPending}
          className="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white hover:bg-violet-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {optimize.isPending ? (
            <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
          ) : (
            <Rocket className="size-4" aria-hidden />
          )}
          {optimize.isPending ? "Optimizing…" : outcome ? "Optimize again" : "Optimize for landing"}
        </button>
        <p className="text-xs text-neutral-400">
          Right-sizes the compute limit, sets a p75 priority fee and a fresh blockhash. Uses about 8–10 Helius credits.
        </p>
      </div>
      <div aria-live="polite" className="sr-only">
        {optimize.isPending ? "Optimizing" : outcome ? (outcome.ok ? "Optimization finished" : "Optimization refused or failed") : ""}
      </div>
      {!optimize.isPending && outcome && !outcome.ok && <ApiErrorAlert error={outcome} action="optimize" onRetry={run} />}
      {!optimize.isPending && outcome?.ok && <OptimizerPanel result={outcome} />}
    </div>
  );
}
