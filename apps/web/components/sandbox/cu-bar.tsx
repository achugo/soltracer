import { DEFAULT_CU_PER_INSTRUCTION, MAX_COMPUTE_UNIT_LIMIT, type ComputeBudget } from "@soltracer/shared/simulation";
import { Cpu, Info, TriangleAlert } from "lucide-react";
import { compactCu, groupDigits } from "@/lib/format.ts";
import { Card } from "./card.tsx";

const pct = (part: number, whole: number) => (whole <= 0 ? 0 : Math.min(100, (part / whole) * 100));

export function CuBar({ used, budget }: { used: number; budget: ComputeBudget }) {
  const ofLimit = pct(used, budget.limit);
  const atLimit = budget.limit > 0 && used >= budget.limit;
  return (
    <Card title="Compute units" icon={<Cpu className="size-4 text-violet-400" aria-hidden />}>
      <p className="text-sm">
        <span className="font-mono">{groupDigits(String(used))}</span>
        <span className="text-neutral-400"> used of </span>
        <span className="font-mono">{groupDigits(String(budget.limit))}</span>
        <span className="text-neutral-400"> limit </span>
        <span className="font-mono text-neutral-300">({ofLimit.toFixed(1)}%)</span>
      </p>

      {/* Scale is the 1.4M per-transaction ceiling; the shaded band is this transaction's limit. */}
      <div
        role="meter"
        aria-label="Compute units used"
        aria-valuemin={0}
        aria-valuemax={budget.limit}
        aria-valuenow={Math.min(used, budget.limit)}
        aria-valuetext={`${used} of ${budget.limit} compute units`}
        className="relative mt-3 h-3 w-full overflow-hidden rounded-full bg-neutral-800"
      >
        <div className="absolute inset-y-0 left-0 bg-violet-900/60" style={{ width: `${pct(budget.limit, MAX_COMPUTE_UNIT_LIMIT)}%` }} />
        <div className="absolute inset-y-0 left-0 rounded-full bg-violet-500" style={{ width: `${pct(used, MAX_COMPUTE_UNIT_LIMIT)}%` }} />
        <div className="absolute inset-y-0 w-0.5 bg-violet-200" style={{ left: `calc(${pct(budget.limit, MAX_COMPUTE_UNIT_LIMIT)}% - 1px)` }} />
      </div>
      <div className="mt-1 flex justify-between font-mono text-xs text-neutral-500">
        <span>0</span>
        <span>limit {compactCu(budget.limit)}</span>
        <span>{compactCu(MAX_COMPUTE_UNIT_LIMIT)} max</span>
      </div>

      {atLimit && (
        <p className="mt-2 flex items-center gap-2 text-sm text-amber-300">
          <TriangleAlert className="size-4" aria-hidden />
          Used the whole limit
        </p>
      )}

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-neutral-400">Limit source</dt>
        <dd>{budget.limitSource === "explicit" ? "Explicit (set by the transaction)" : "Default (no limit set)"}</dd>
        {budget.loadedAccountsDataSizeLimit !== null && (
          <>
            <dt className="text-neutral-400">Loaded accounts data limit</dt>
            <dd className="font-mono">{groupDigits(String(budget.loadedAccountsDataSizeLimit))} bytes</dd>
          </>
        )}
      </dl>
      {budget.limitSource === "default" && (
        <p
          className="mt-2 flex items-start gap-2 text-xs text-neutral-400"
          title={`Default: ${groupDigits(String(budget.defaultLimit))} CU`}
        >
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            The default is {compactCu(DEFAULT_CU_PER_INSTRUCTION)} per non-ComputeBudget instruction, per the docs (
            <span className="font-mono">{groupDigits(String(budget.defaultLimit))}</span> here). The runtime may differ
            for built-in programs.
          </span>
        </p>
      )}
    </Card>
  );
}
