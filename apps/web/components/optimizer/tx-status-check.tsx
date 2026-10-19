"use client";

import type { TxStatusResult } from "@soltracer/shared/optimize";
import { CircleCheck, CircleX, Clock, LoaderCircle, Search } from "lucide-react";
import { groupDigits } from "@/lib/format.ts";
import { useTxStatus } from "@/lib/use-optimize.ts";
import { ApiErrorAlert } from "../sandbox/api-error-alert.tsx";

function errText(err: unknown): string {
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

function StatusLine({ status }: { status: TxStatusResult["status"] }) {
  if (status === null) {
    return (
      <p className="flex items-start gap-2 text-sm text-neutral-300">
        <Clock className="mt-0.5 size-4 shrink-0 text-neutral-400" aria-hidden />
        Not found yet. It may still be in flight, or it was dropped (for example, the blockhash expired).
      </p>
    );
  }
  const level = status.confirmationStatus ?? "unknown";
  if (status.err !== null) {
    return (
      <div className="space-y-1 text-sm">
        <p className="flex items-center gap-2 font-semibold text-red-200">
          <CircleX className="size-4 shrink-0 text-red-400" aria-hidden />
          Failed on-chain ({level}) at slot <span className="font-mono">{groupDigits(String(status.slot))}</span>
        </p>
        <pre className="overflow-x-auto rounded-md bg-neutral-950 p-2 font-mono text-xs text-neutral-300">{errText(status.err)}</pre>
      </div>
    );
  }
  return (
    <p className="flex items-center gap-2 text-sm text-green-200">
      <CircleCheck className="size-4 shrink-0 text-green-400" aria-hidden />
      Landed: <span className="font-mono">{level}</span> at slot{" "}
      <span className="font-mono">{groupDigits(String(status.slot))}</span>
    </p>
  );
}

/** One lookup per click; nothing polls. */
export function TxStatusCheck({ signature }: { signature: string }) {
  const check = useTxStatus();
  const outcome = check.data;
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => check.mutate(signature)}
        disabled={check.isPending}
        className="flex min-h-11 items-center gap-2 rounded-lg border border-neutral-700 px-3 text-sm text-neutral-100 hover:bg-neutral-900 disabled:opacity-50"
      >
        {check.isPending ? (
          <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
        ) : (
          <Search className="size-4" aria-hidden />
        )}
        {check.isPending ? "Checking…" : "Check status"}
      </button>
      <div aria-live="polite">
        {!check.isPending && outcome && (outcome.ok ? <StatusLine status={outcome.status} /> : <ApiErrorAlert error={outcome} action="status" />)}
      </div>
    </div>
  );
}
