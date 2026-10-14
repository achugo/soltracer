"use client";

import { Check, Copy, ScrollText } from "lucide-react";
import { useEffect, useState } from "react";
import { DisclosureChevron } from "./disclosure-chevron.tsx";

type CopyState = "idle" | "copied" | "failed";
const COPY_LABEL: Record<CopyState, string> = { idle: "Copy logs", copied: "Copied", failed: "Copy failed" };

/** `full`: the local engine returns every line; RPC logs may be truncated by the node. */
export function LogsPanel({ logs, full }: { logs: string[]; full: boolean }) {
  const [copy, setCopy] = useState<CopyState>("idle");

  useEffect(() => {
    if (copy === "idle") return;
    const t = setTimeout(() => setCopy("idle"), 2000);
    return () => clearTimeout(t);
  }, [copy]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(logs.join("\n"));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };

  return (
    <details className="group rounded-lg border border-neutral-800 bg-neutral-900/40 p-2">
      <summary className="flex min-h-11 cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden gap-2 rounded-lg px-2 text-sm font-semibold text-neutral-200 hover:bg-neutral-900">
        <DisclosureChevron />
        <ScrollText className="size-4 text-violet-400" aria-hidden />
        {full ? "Full logs" : "Raw logs"} ({logs.length} lines)
      </summary>
      {!full && <p className="px-2 pt-1 text-xs text-neutral-400">RPC logs may be truncated. Run on Local for full logs.</p>}
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={onCopy}
          disabled={logs.length === 0}
          className="flex min-h-11 items-center gap-2 rounded-lg border border-neutral-700 px-3 text-sm text-neutral-200 hover:bg-neutral-900 disabled:opacity-50"
        >
          {copy === "copied" ? <Check className="size-4 text-green-400" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          <span aria-live="polite">{COPY_LABEL[copy]}</span>
        </button>
      </div>
      {logs.length === 0 ? (
        <p className="p-2 text-sm text-neutral-400">No logs.</p>
      ) : (
        <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-neutral-950 p-3 font-mono text-xs leading-relaxed text-neutral-300">
          {logs.join("\n")}
        </pre>
      )}
    </details>
  );
}
