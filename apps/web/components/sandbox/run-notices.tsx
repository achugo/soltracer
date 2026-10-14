import type { SimulationResult } from "@soltracer/shared/simulation";
import { Database, FlaskConical, Info } from "lucide-react";
import { summarizeOverride } from "@/lib/run-view.ts";
import { CopyButton } from "../copy-button.tsx";
import { Address } from "./address.tsx";

/** A local request that could not load state ran on RPC instead. */
export function FallbackNotice({ reason }: { reason: string }) {
  return (
    <p role="note" className="flex items-start gap-2 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        <span className="font-semibold">Ran on RPC instead of local:</span> <span className="break-words">{reason}</span>
      </span>
    </p>
  );
}

/** Prominent: these results are not what mainnet would do today. */
export function OverridesApplied({ overrides, tokens }: { overrides: SimulationResult["overrides"]; tokens: SimulationResult["balances"]["tokens"] }) {
  const n = overrides.length;
  return (
    <section aria-label="Overrides applied" className="rounded-lg border border-violet-700 bg-violet-950/40 p-3 text-sm">
      <p className="flex items-center gap-2 font-semibold text-violet-100">
        <FlaskConical className="size-4 shrink-0 text-violet-300" aria-hidden />
        Simulated with {n} override{n === 1 ? "" : "s"}; not mainnet state
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {overrides.map((o, i) => {
          const s = summarizeOverride(o, tokens);
          return (
            <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-neutral-200">
              <span className="rounded border border-violet-800 px-1.5 text-xs text-violet-300">{s.kind}</span>
              <span className="text-neutral-400">{s.kind === "Token" ? "owner" : "account"}</span>
              <Address value={s.target} />
              {s.mint && (
                <>
                  <span className="text-neutral-400">mint</span>
                  <Address value={s.mint} />
                </>
              )}
              <span aria-hidden className="text-neutral-500">→</span>
              <span className="font-mono">{s.value}</span>
              {s.dataOwner && (
                <>
                  <span className="text-neutral-400">owner</span>
                  <Address value={s.dataOwner} />
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The stored run. `/runs/[id]` arrives in Phase 5, so this is not a link yet. */
export function RunId({ id }: { id: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Database className="size-4 text-violet-400" aria-hidden />
      <span className="text-neutral-400">Run id (saved)</span>
      <span className="break-all font-mono text-neutral-100">{id}</span>
      <CopyButton value={id} label="Copy run id" />
    </div>
  );
}
