"use client";

import type { FeePreset } from "@soltracer/shared/optimize";
import { useId } from "react";
import { groupDigits } from "@/lib/format.ts";
import type { PresetOption } from "@/lib/optimize-view.ts";

/** Switching presets is local: every preset's transaction is already in the result. */
export function PresetPicker({ options, onChange }: { options: PresetOption[]; onChange: (preset: FeePreset) => void }) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-sm font-semibold text-neutral-200">Priority fee preset</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((o) => (
          <label
            key={o.preset}
            className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-violet-400 ${
              o.selected ? "border-violet-500 bg-violet-950/30" : "border-neutral-800 hover:bg-neutral-900"
            }`}
          >
            <input
              type="radio"
              name={name}
              value={o.preset}
              checked={o.selected}
              onChange={() => onChange(o.preset)}
              className="mt-0.5 size-4 shrink-0 accent-violet-500"
            />
            <span className="min-w-0 space-y-1">
              <span className="block font-medium text-neutral-100">{o.label}</span>
              <span className="block">
                <span className="font-mono">{groupDigits(o.priceMicroLamports)}</span>
                <span className="text-neutral-400"> µ-lamports/CU</span>
              </span>
              <span className="block">
                <span className="font-mono">{o.totalSol} SOL</span>
                <span className="text-neutral-400"> total</span>
              </span>
              <span className="block font-mono text-xs text-neutral-400">{groupDigits(o.totalLamports)} lamports</span>
              <span className="block text-xs text-neutral-400">
                {o.simulated ? "Simulated after rewrite" : "Not simulated, same instructions and limit"}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
