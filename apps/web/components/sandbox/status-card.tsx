import type { SimulationResult } from "@soltracer/shared/simulation";
import { CircleCheck, CircleX } from "lucide-react";
import { toHex } from "@/lib/format.ts";
import { Address } from "./address.tsx";

const SOURCE_LABEL = { idl: "Program IDL", builtin: "Built-in table", raw: "Raw (not decoded)" } as const;

export function StatusCard({ status }: { status: SimulationResult["status"] }) {
  if (status.success) {
    return (
      <section aria-label="Status" className="flex items-center gap-3 rounded-lg border border-green-900/70 bg-green-950/30 p-4">
        <CircleCheck className="size-6 shrink-0 text-green-400" aria-hidden />
        <p className="font-semibold text-green-200">Success: the transaction would succeed</p>
      </section>
    );
  }

  const e = status.error;
  const otherProgram = e.programId !== null && e.programId !== e.failingProgramId ? e.programId : null;
  return (
    <section aria-label="Status" className="rounded-lg border border-red-900/70 bg-red-950/30 p-4">
      <div className="flex items-start gap-3">
        <CircleX className="mt-0.5 size-6 shrink-0 text-red-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-red-200">
            Failed{e.name ? <>: <span className="font-mono">{e.name}</span></> : null}
          </p>
          <p className="mt-1 break-words text-sm text-neutral-200">{e.message}</p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-neutral-400">Code</dt>
            <dd className="font-mono">{e.code === null ? "none" : `${e.code} (${toHex(e.code)})`}</dd>
            <dt className="text-neutral-400">Instruction</dt>
            <dd className="font-mono">{e.instructionIndex === null ? "not reported" : `#${e.instructionIndex}`}</dd>
            <dt className="text-neutral-400">Failing program</dt>
            <dd className="min-w-0">{e.failingProgramId ? <Address value={e.failingProgramId} /> : "unknown"}</dd>
            {otherProgram && (
              <>
                <dt className="text-neutral-400">Instruction program</dt>
                <dd className="min-w-0"><Address value={otherProgram} /></dd>
              </>
            )}
            <dt className="text-neutral-400">Decoded from</dt>
            <dd>{SOURCE_LABEL[e.source]}</dd>
          </dl>
        </div>
      </div>
    </section>
  );
}
