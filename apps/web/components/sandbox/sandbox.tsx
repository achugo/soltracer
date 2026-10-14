"use client";

import { useState } from "react";
import { useSimulate } from "@/lib/use-simulate.ts";
import { OptimizeSection } from "../optimizer/optimize-section.tsx";
import { ApiErrorAlert } from "./api-error-alert.tsx";
import { ResultView } from "./result-view.tsx";
import { TxInput } from "./tx-input.tsx";

export function Sandbox() {
  const simulate = useSimulate();
  const [lastTx, setLastTx] = useState<string | null>(null);

  const run = (tx: string) => {
    setLastTx(tx);
    simulate.mutate(tx);
  };
  const outcome = simulate.data;

  return (
    <div className="flex flex-col gap-6">
      <TxInput onSubmit={run} pending={simulate.isPending} />
      <div aria-live="polite" className="sr-only">
        {simulate.isPending ? "Simulating" : outcome ? (outcome.ok ? "Simulation finished" : "Simulation failed to run") : ""}
      </div>
      {!simulate.isPending && outcome && !outcome.ok && (
        <ApiErrorAlert error={outcome} onRetry={lastTx === null ? undefined : () => run(lastTx)} />
      )}
      {outcome?.ok && (
        <ResultView
          result={outcome}
          // Keyed by submission so a new simulation clears the previous optimize result.
          actions={lastTx === null ? undefined : <OptimizeSection key={simulate.submittedAt} tx={lastTx} />}
        />
      )}
    </div>
  );
}
