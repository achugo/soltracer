import type { SimulationResult } from "@soltracer/shared/simulation";
import { Cpu, Server, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { groupDigits } from "@/lib/format.ts";
import { ENGINE_LABEL } from "@/lib/run-view.ts";
import { AccountsPanel } from "./accounts-panel.tsx";
import { BalanceTable } from "./balance-table.tsx";
import { Badge } from "./card.tsx";
import { CuBar } from "./cu-bar.tsx";
import { FeeCard } from "./fee-card.tsx";
import { InstructionCuTable } from "./instruction-cu-table.tsx";
import { LogsPanel } from "./logs-panel.tsx";
import { FallbackNotice, OverridesApplied, RunId } from "./run-notices.tsx";
import { StatusCard } from "./status-card.tsx";

const versionLabel = (v: SimulationResult["version"]) => (v === "legacy" ? "legacy" : `v${v}`);

/** `actions` renders under the status, compute and fee cards (the landing optimizer). */
export function ResultView({ result, actions }: { result: SimulationResult; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2" aria-label="Transaction summary" role="group">
        <Badge title="Engine this run used">
          {result.engine === "local" ? <Cpu className="size-3.5 text-violet-400" aria-hidden /> : <Server className="size-3.5 text-violet-400" aria-hidden />}
          {ENGINE_LABEL[result.engine]}
        </Badge>
        <Badge title="Transaction version">version {versionLabel(result.version)}</Badge>
        <Badge title="Detected input encoding">{result.encoding}</Badge>
        <Badge title="Accounts, including lookup-table entries">{result.accounts.length} accounts</Badge>
        <Badge title="Helius credits this simulation spent">{result.credits} credits</Badge>
        <Badge title="Slot the simulation ran against">slot {groupDigits(String(result.slot))}</Badge>
      </div>
      {result.runId !== null && <RunId id={result.runId} />}
      {result.fallbackReason !== null && <FallbackNotice reason={result.fallbackReason} />}
      {result.overrides.length > 0 && <OverridesApplied overrides={result.overrides} tokens={result.balances.tokens} />}
      {result.signed && (
        <p role="note" className="flex items-start gap-2 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">Signatures present.</span> The simulator ignores them, and changing the
            transaction would invalidate them.
          </span>
        </p>
      )}
      <StatusCard status={result.status} />
      <div className="grid gap-4 md:grid-cols-2">
        <CuBar used={result.unitsConsumed} budget={result.computeBudget} />
        <FeeCard fee={result.fee} budget={result.computeBudget} version={result.version} />
      </div>
      <InstructionCuTable perInstruction={result.perInstruction} unitsConsumed={result.unitsConsumed} />
      {actions}
      <BalanceTable balances={result.balances} feePayer={result.accounts[0]?.address ?? null} />
      <AccountsPanel accounts={result.accounts} />
      <LogsPanel logs={result.logs} full={result.engine === "local"} />
    </div>
  );
}
