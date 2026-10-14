"use client";

import type { Engine } from "@soltracer/shared/simulation";
import { useId } from "react";

const OPTIONS: { value: Engine; label: string; detail: string }[] = [
  { value: "local", label: "Local", detail: "LiteSVM, mainnet state now" },
  { value: "rpc", label: "RPC", detail: "Helius simulateTransaction" },
];

export function EngineToggle({ value, onChange, disabled }: { value: Engine; onChange: (e: Engine) => void; disabled: boolean }) {
  const name = useId();
  const hintId = useId();
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={hintId} disabled={disabled}>
      <legend className="mb-2 text-sm font-medium text-neutral-200">Run on</legend>
      <div className="flex flex-wrap gap-2">
        {OPTIONS.map((o) => (
          <label
            key={o.value}
            className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-3 text-sm text-neutral-200 hover:bg-neutral-800/60 has-[:checked]:border-violet-500 has-[:checked]:bg-violet-950/40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-violet-500/40"
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="size-4 accent-violet-500"
            />
            <span className="font-medium">{o.label}</span>
            <span className="text-neutral-400">({o.detail})</span>
          </label>
        ))}
      </div>
      <p id={hintId} className="text-xs text-neutral-400">
        Local supports state overrides and returns full, untruncated logs.
      </p>
    </fieldset>
  );
}
