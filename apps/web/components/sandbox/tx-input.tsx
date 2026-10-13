"use client";

import { simulateRequestSchema } from "@soltracer/shared/simulation";
import { LoaderCircle, Play } from "lucide-react";
import { useDeferredValue, useId, useMemo, useState, type FormEvent } from "react";
import { groupDigits } from "@/lib/format.ts";
import { detectTxInput } from "@/lib/tx-input.ts";

export function TxInput({ onSubmit, pending }: { onSubmit: (tx: string) => void; pending: boolean }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const deferred = useDeferredValue(value);
  // Base58 decoding is quadratic; the deferred value keeps typing responsive.
  const hint = useMemo(() => detectTxInput(deferred), [deferred]);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = simulateRequestSchema.safeParse({ tx: value });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid transaction");
      return;
    }
    setError(null);
    onSubmit(parsed.data.tx);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2" aria-busy={pending}>
      <label htmlFor={inputId} className="text-sm font-medium text-neutral-200">
        Transaction <span className="font-normal text-neutral-400">(base64 or base58)</span>
      </label>
      <textarea
        id={inputId}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        rows={5}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        aria-invalid={error ? true : undefined}
        placeholder="AQAAAAAAAAAAAAAA…"
        className="w-full resize-y break-all rounded-lg border border-neutral-800 bg-neutral-900 p-3 font-mono text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p id={hintId} className="text-xs text-neutral-400">
          {hint === null ? (
            "Encoding is detected as you type; the engine decides."
          ) : hint.encoding === "unknown" ? (
            <>Detected: <span className="font-medium text-amber-300">unknown</span> ({hint.reason})</>
          ) : (
            <>
              Detected: <span className="font-mono text-violet-300">{hint.encoding}</span>,{" "}
              <span className="font-mono">{groupDigits(String(hint.bytes))}</span> bytes
            </>
          )}
        </p>
        <button
          type="submit"
          disabled={pending || value.trim() === ""}
          className="flex min-h-11 min-w-32 items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white hover:bg-violet-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? (
            <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
          ) : (
            <Play className="size-4" aria-hidden />
          )}
          {pending ? "Simulating…" : "Simulate"}
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}
