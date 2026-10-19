import type { ComputeBudget, Fee, SimulationResult } from "@soltracer/shared/simulation";
import { Coins } from "lucide-react";
import { groupDigits, lamportsToSol } from "@/lib/format.ts";
import { Card } from "./card.tsx";

function Row({ label, lamports, strong = false }: { label: string; lamports: string; strong?: boolean }) {
  return (
    <tr className={strong ? "border-t border-neutral-800 font-semibold" : undefined}>
      <th scope="row" className="py-1 pr-4 text-left font-normal text-neutral-400">{label}</th>
      <td className="py-1 pr-4 text-right font-mono">{lamportsToSol(lamports)} SOL</td>
      <td className="py-1 text-right font-mono text-neutral-400">{groupDigits(lamports)} lamports</td>
    </tr>
  );
}

export function FeeCard({ fee, budget, version }: { fee: Fee; budget: ComputeBudget; version: SimulationResult["version"] }) {
  const v1 = version === 1;
  return (
    <Card title="Fee" icon={<Coins className="size-4 text-violet-400" aria-hidden />}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Transaction fee in SOL and lamports</caption>
          <tbody>
            <Row label="Base" lamports={fee.baseLamports} />
            <Row label={v1 ? "v1 total priority fee" : "Priority"} lamports={fee.priorityLamports} />
            <Row label="Total" lamports={fee.totalLamports} strong />
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-neutral-400">
        {v1 || budget.priceMicroLamports === null ? (
          "Version 1 sets a total priority fee in its config instead of a per-CU price."
        ) : (
          <>
            CU price: <span className="font-mono text-neutral-200">{groupDigits(budget.priceMicroLamports)}</span>{" "}
            micro-lamports per CU
          </>
        )}
      </p>
    </Card>
  );
}
