"use client";

import type { FeePreset, OptimizeResult } from "@soltracer/shared/optimize";
import { useWallet } from "@solana/wallet-adapter-react";
import { CircleCheck, Clock, Gauge } from "lucide-react";
import { useState } from "react";
import { groupDigits } from "@/lib/format.ts";
import { checkFeePayer, compareFees, describeWarnings, PRESET_LABEL, presetOptions } from "@/lib/optimize-view.ts";
import { Address } from "../sandbox/address.tsx";
import { Badge, Card } from "../sandbox/card.tsx";
import { StatusCard } from "../sandbox/status-card.tsx";
import { FeeComparisonTable } from "./fee-comparison.tsx";
import { OptimizeWarnings } from "./optimize-warnings.tsx";
import { PresetPicker } from "./preset-picker.tsx";
import { SendPanel } from "./send-panel.tsx";

function AfterStatus({ result }: { result: OptimizeResult }) {
  // The engine refuses with OPTIMIZE_NOT_FIXABLE when the rewrite fails, so this is defensive.
  if (!result.after.status.success) return <StatusCard status={result.after.status} />;
  return (
    <section aria-label="After status" className="flex items-start gap-3 rounded-lg border border-green-900/70 bg-green-950/30 p-4">
      <CircleCheck className="mt-0.5 size-6 shrink-0 text-green-400" aria-hidden />
      <div>
        <p className="font-semibold text-green-200">After: succeeded in simulation</p>
        <p className="mt-1 text-sm text-neutral-300">
          The rewritten transaction with the {result.chosen} preset simulated successfully at slot{" "}
          <span className="font-mono">{groupDigits(String(result.after.slot))}</span>. Simulation does not guarantee it lands.
        </p>
      </div>
    </section>
  );
}

export function OptimizerPanel({ result }: { result: OptimizeResult }) {
  const [selected, setSelected] = useState<FeePreset>(result.chosen);
  const { publicKey } = useWallet();
  const feePayer = checkFeePayer(result, publicKey ? publicKey.toBase58() : null);
  const warnings = describeWarnings(result, feePayer);
  const comparison = compareFees(result, selected);

  return (
    <Card title="Optimized for landing" icon={<Gauge className="size-4 text-violet-400" aria-hidden />}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge title="Compute unit limit in the rewritten transaction">limit {groupDigits(String(result.computeUnitLimit))} CU</Badge>
          <Badge title="Helius credits this optimization spent">{result.credits} credits</Badge>
        </div>
        <OptimizeWarnings warnings={warnings} />
        <AfterStatus result={result} />
        <PresetPicker options={presetOptions(result, selected)} onChange={setSelected} />
        <FeeComparisonTable comparison={comparison} presetLabel={PRESET_LABEL[selected]} />
        {!comparison.afterSimulated && (
          <p className="text-xs text-neutral-400">
            CU usage after is from the {result.chosen} simulation; {selected} was not simulated but has the same
            instructions and limit.
          </p>
        )}
        <p className="flex items-start gap-2 text-sm text-neutral-400">
          <Clock className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            Blockhash <Address value={result.blockhash} className="text-neutral-200" /> is valid until block height{" "}
            <span className="font-mono text-neutral-200">{groupDigits(result.lastValidBlockHeight)}</span>; optimize
            again if it expires.
          </span>
        </p>
        <SendPanel result={result} selected={selected} />
      </div>
    </Card>
  );
}
