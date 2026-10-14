import type { FeeComparison, FeeSide } from "@/lib/optimize-view.ts";
import { groupDigits, lamportsToSol } from "@/lib/format.ts";

// Neutral on purpose: paying more is the point of optimizing, not a failure.
const DELTA_WORD = { up: "more", down: "less", none: "no change" } as const;

function Lamports({ value }: { value: string }) {
  return (
    <>
      <span className="block font-mono">{lamportsToSol(value)} SOL</span>
      <span className="block font-mono text-xs text-neutral-400">{groupDigits(value)} lamports</span>
    </>
  );
}

function Cu({ side }: { side: FeeSide }) {
  return (
    <>
      <span className="font-mono">{groupDigits(String(side.cuUsed))}</span>
      <span className="text-neutral-400"> of </span>
      <span className="font-mono">{groupDigits(String(side.cuLimit))}</span>
    </>
  );
}

const th = "px-3 py-2 text-left font-medium text-neutral-400";
const td = "px-3 py-2 align-top";

export function FeeComparisonTable({ comparison, presetLabel }: { comparison: FeeComparison; presetLabel: string }) {
  const { before, after, totalDelta } = comparison;
  return (
    <div className="overflow-x-auto rounded-md border border-neutral-800">
      <table className="w-full text-sm">
        <caption className="sr-only">Compute and fees before and after optimizing</caption>
        <thead className="bg-neutral-900">
          <tr>
            <td className={th} />
            <th scope="col" className={th}>Before (as pasted)</th>
            <th scope="col" className={th}>After ({presetLabel})</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800">
          <tr>
            <th scope="row" className={th}>CU used of limit</th>
            <td className={td}><Cu side={before} /></td>
            <td className={td}><Cu side={after} /></td>
          </tr>
          <tr>
            <th scope="row" className={th}>Limit</th>
            <td className={td}>{before.limitSource === "explicit" ? "Explicit" : "Default (none set)"}</td>
            <td className={td}>{after.limitSource === "explicit" ? "Explicit" : "Default (none set)"}</td>
          </tr>
          <tr>
            <th scope="row" className={th}>Priority fee</th>
            <td className={td}><Lamports value={before.priorityLamports} /></td>
            <td className={td}><Lamports value={after.priorityLamports} /></td>
          </tr>
          <tr className="font-semibold">
            <th scope="row" className={th}>Total fee</th>
            <td className={td}><Lamports value={before.totalLamports} /></td>
            <td className={td}><Lamports value={after.totalLamports} /></td>
          </tr>
        </tbody>
      </table>
      <p className="border-t border-neutral-800 px-3 py-2 text-sm text-neutral-400">
        Change in total fee:{" "}
        <span className="font-mono text-neutral-100">{totalDelta.text} SOL</span>{" "}
        ({DELTA_WORD[totalDelta.direction]})
      </p>
    </div>
  );
}
