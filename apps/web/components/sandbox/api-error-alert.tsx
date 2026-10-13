"use client";

import type { ErrorResponse } from "@soltracer/shared/errors";
import { RotateCw, TriangleAlert } from "lucide-react";
import { describeApiError } from "@/lib/api-error.ts";

export function ApiErrorAlert({ error, onRetry }: { error: ErrorResponse; onRetry?: () => void }) {
  const view = describeApiError(error);
  return (
    <div role="alert" className="rounded-lg border border-red-900/70 bg-red-950/30 p-4 text-sm">
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-red-400" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-semibold text-red-200">
            {view.title} <span className="font-mono text-xs font-normal text-red-300/80">({error.code})</span>
          </p>
          <p className="break-words text-neutral-300">{view.message}</p>
          {view.tried.length > 0 && (
            <div>
              <p className="text-neutral-400">Encodings tried:</p>
              <ul className="mt-1 space-y-1">
                {view.tried.map((t, i) => (
                  <li key={`${t.encoding}-${i}`} className="break-words">
                    <span className="font-mono text-neutral-100">{t.encoding}</span>
                    <span className="text-neutral-400">: {t.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {view.hint && <p className="text-neutral-400">{view.hint}</p>}
          <div className="flex flex-wrap gap-2">
            {view.retryable && onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="flex min-h-11 items-center gap-2 rounded-lg border border-neutral-700 px-3 text-neutral-100 hover:bg-neutral-900"
              >
                <RotateCw className="size-4" aria-hidden />
                Retry
              </button>
            )}
            {view.signIn && (
              <a
                href="/login?next=%2Fsandbox"
                className="flex min-h-11 items-center rounded-lg border border-neutral-700 px-3 text-neutral-100 hover:bg-neutral-900"
              >
                Sign in again
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
