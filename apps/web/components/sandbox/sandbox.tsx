"use client";

import type { Engine } from "@soltracer/shared/simulation";
import { Info, TriangleAlert } from "lucide-react";
import { useMemo, useReducer, useState } from "react";
import { buildOverrides, initialRowsState, rowsReducer, visibleErrors } from "@/lib/override-form.ts";
import type { SimulateInput } from "@/lib/simulate-response.ts";
import { useSimulate } from "@/lib/use-simulate.ts";
import { OptimizeSection } from "../optimizer/optimize-section.tsx";
import { ApiErrorAlert } from "./api-error-alert.tsx";
import { EngineToggle } from "./engine-toggle.tsx";
import { OverrideEditor } from "./override-editor.tsx";
import { ResultView } from "./result-view.tsx";
import { TxInput } from "./tx-input.tsx";

export function Sandbox() {
  const simulate = useSimulate();
  const [engine, setEngine] = useState<Engine>("local");
  const [rows, dispatch] = useReducer(rowsReducer, initialRowsState);
  // Set by a submit with invalid overrides: from then on, empty required fields show their errors too.
  const [showAllErrors, setShowAllErrors] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [lastRequest, setLastRequest] = useState<SimulateInput | null>(null);

  const built = useMemo(() => buildOverrides(rows.rows), [rows.rows]);
  const errors = built.ok ? {} : visibleErrors(rows.rows, built.rowErrors, showAllErrors);
  const outcome = simulate.data;
  const feePayer = outcome?.ok ? (outcome.accounts[0]?.address ?? null) : null;

  const send = (request: SimulateInput) => {
    setLastRequest(request);
    simulate.mutate(request);
  };

  const run = (tx: string) => {
    if (engine === "rpc") {
      setBlocked(false);
      send({ tx, engine, overrides: [] });
      return;
    }
    if (!built.ok) {
      setShowAllErrors(true);
      setBlocked(true);
      return;
    }
    setBlocked(false);
    setShowAllErrors(false);
    send({ tx, engine, overrides: built.overrides });
  };

  return (
    <div className="flex flex-col gap-6">
      <EngineToggle value={engine} onChange={setEngine} disabled={simulate.isPending} />
      {engine === "local" ? (
        <OverrideEditor
          state={rows}
          dispatch={dispatch}
          errors={errors}
          listError={built.ok ? null : built.listError}
          feePayer={feePayer}
        />
      ) : (
        rows.rows.length > 0 && (
          <p className="flex items-center gap-2 text-xs text-neutral-400">
            <Info className="size-4 shrink-0" aria-hidden />
            {rows.rows.length} override{rows.rows.length === 1 ? " is" : "s are"} kept but not sent: RPC can&apos;t apply
            overrides.
          </p>
        )
      )}
      <TxInput onSubmit={run} pending={simulate.isPending} />
      {blocked && engine === "local" && !built.ok && (
        <p role="alert" className="flex items-center gap-2 text-sm text-red-400">
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          Fix the overrides above before simulating.
        </p>
      )}
      <div aria-live="polite" className="sr-only">
        {simulate.isPending ? "Simulating" : outcome ? (outcome.ok ? "Simulation finished" : "Simulation failed to run") : ""}
      </div>
      {!simulate.isPending && outcome && !outcome.ok && (
        <ApiErrorAlert error={outcome} onRetry={lastRequest === null ? undefined : () => send(lastRequest)} />
      )}
      {outcome?.ok && (
        <ResultView
          result={outcome}
          // Keyed by submission so a new simulation clears the previous optimize result.
          actions={lastRequest === null ? undefined : <OptimizeSection key={simulate.submittedAt} tx={lastRequest.tx} />}
        />
      )}
    </div>
  );
}
