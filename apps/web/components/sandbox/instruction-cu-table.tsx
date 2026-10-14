import type { SimulationResult } from "@soltracer/shared/simulation";
import { ListOrdered } from "lucide-react";
import { groupDigits } from "@/lib/format.ts";
import { instructionCuView } from "@/lib/run-view.ts";
import { Address } from "./address.tsx";
import { Card } from "./card.tsx";

const th = "px-3 py-2 text-left font-medium text-neutral-400";
const td = "px-3 py-2 whitespace-nowrap";

/** CU per top-level instruction, from the "consumed N of M" log lines. */
export function InstructionCuTable({ perInstruction, unitsConsumed }: { perInstruction: SimulationResult["perInstruction"]; unitsConsumed: number }) {
  const view = instructionCuView(perInstruction, unitsConsumed);
  return (
    <Card title="Compute units per instruction" icon={<ListOrdered className="size-4 text-violet-400" aria-hidden />}>
      {view.rows.length === 0 ? (
        <p className="text-sm text-neutral-400">No per-instruction data reported.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-800">
          <table className="w-full text-sm">
            <caption className="sr-only">Compute units per top-level instruction, relative to the transaction total</caption>
            <thead className="bg-neutral-900">
              <tr>
                <th scope="col" className={th}>#</th>
                <th scope="col" className={th}>Program</th>
                <th scope="col" className={`${th} text-right`}>Units</th>
                <th scope="col" className={`${th} w-1/3`}>Share of total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {view.rows.map((r) => (
                <tr key={r.index}>
                  <td className={`${td} font-mono text-neutral-500`}>{r.index}</td>
                  <td className={td}><Address value={r.programId} /></td>
                  <td className={`${td} text-right`}>
                    {r.units === null ? (
                      <span className="text-neutral-400">not reported (builtin / didn&apos;t run)</span>
                    ) : (
                      <span className="font-mono">{groupDigits(String(r.units))}</span>
                    )}
                  </td>
                  <td className={td}>
                    {r.units !== null && (
                      <div className="flex items-center gap-2">
                        <div className="h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-neutral-800" aria-hidden>
                          <div className="h-full rounded-full bg-violet-500" style={{ width: `${r.percent}%` }} />
                        </div>
                        <span className="w-12 text-right font-mono text-xs text-neutral-300">{r.percent.toFixed(1)}%</span>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-neutral-400">
        Total <span className="font-mono text-neutral-200">{groupDigits(String(unitsConsumed))}</span> CU
        {view.unattributed > 0 && (
          <>
            ; <span className="font-mono text-neutral-200">{groupDigits(String(view.unattributed))}</span> not attributed to
            an instruction (builtins and unreported)
          </>
        )}
        .
      </p>
    </Card>
  );
}
