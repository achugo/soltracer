"use client";

import { MAX_OVERRIDES } from "@soltracer/shared/simulation";
import { CircleCheck, Plus, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { useId, type Dispatch } from "react";
import { groupDigits } from "@/lib/format.ts";
import { dataSize, type RowErrors, type RowsAction, type RowsState } from "@/lib/override-form.ts";
import { OverrideRowEditor } from "./override-row.tsx";

const SIZE_STYLE = {
  ok: { className: "text-neutral-400", label: "within limit" },
  warn: { className: "text-amber-300", label: "near the 1 MiB limit" },
  over: { className: "text-red-400", label: "over the 1 MiB limit" },
} as const;

export interface OverrideEditorProps {
  state: RowsState;
  dispatch: Dispatch<RowsAction>;
  /** Errors to show, by row id; the parent decides when (typed fields, or after a submit). */
  errors: Record<number, RowErrors>;
  listError: string | null;
  feePayer: string | null;
}

/** State overrides for a local run: SOL balance, token balance or raw account data. */
export function OverrideEditor({ state, dispatch, errors, listError, feePayer }: OverrideEditorProps) {
  const headingId = useId();
  const size = dataSize(state.rows);
  const hasData = state.rows.some((r) => r.kind === "data");
  const atLimit = state.rows.length >= MAX_OVERRIDES;
  const sizeStyle = SIZE_STYLE[size.level];

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-lg border border-neutral-800 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-neutral-200">
          <SlidersHorizontal className="size-4 text-violet-400" aria-hidden />
          State overrides <span className="font-mono font-normal text-neutral-400">({state.rows.length}/{MAX_OVERRIDES})</span>
        </h2>
        <button
          type="button"
          onClick={() => dispatch({ type: "add" })}
          disabled={atLimit}
          className="flex min-h-11 items-center gap-2 rounded-lg border border-violet-700 px-3 text-sm text-violet-200 hover:bg-violet-950/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="size-4" aria-hidden />
          {atLimit ? `Limit reached (${MAX_OVERRIDES})` : "Add override"}
        </button>
      </div>

      {state.rows.length === 0 ? (
        <p className="text-xs text-neutral-400">
          None. The run uses mainnet state as it is now. Add an override to change a balance or account before running.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {state.rows.map((row, i) => (
            <OverrideRowEditor
              key={row.id}
              row={row}
              position={i + 1}
              errors={errors[row.id] ?? {}}
              feePayer={feePayer}
              onChange={(patch) => dispatch({ type: "update", id: row.id, patch })}
              onRemove={() => dispatch({ type: "remove", id: row.id })}
            />
          ))}
        </ol>
      )}

      {hasData && (
        <p className={`flex items-center gap-2 text-xs ${sizeStyle.className}`} aria-live="polite">
          {size.level === "ok" ? <CircleCheck className="size-4" aria-hidden /> : <TriangleAlert className="size-4" aria-hidden />}
          <span>
            Data overrides: <span className="font-mono">{groupDigits(String(size.bytes))}</span> of{" "}
            <span className="font-mono">{groupDigits(String(size.limit))}</span> bytes ({sizeStyle.label})
          </span>
        </p>
      )}

      {listError && (
        <p role="alert" className="flex items-center gap-2 text-sm text-red-400">
          <TriangleAlert className="size-4" aria-hidden />
          {listError}
        </p>
      )}
    </section>
  );
}
