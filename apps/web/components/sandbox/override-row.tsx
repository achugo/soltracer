"use client";

import { Trash2, UserRound } from "lucide-react";
import { useId } from "react";
import type { OverrideKind, OverrideRow, RowErrors, RowField } from "@/lib/override-form.ts";

const KIND_LABEL: Record<OverrideKind, string> = { sol: "SOL balance", token: "Token balance", data: "Raw account data" };

const inputClass =
  "min-h-11 w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 font-mono text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/40 aria-[invalid=true]:border-red-700";
const smallButton =
  "flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-neutral-700 px-3 text-xs text-neutral-200 hover:bg-neutral-900";

interface FieldProps {
  label: string;
  value: string;
  error: string | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  /** Fills this field with the last result's fee payer. */
  feePayer?: string | null;
  multiline?: boolean;
  inputMode?: "decimal" | "numeric";
}

function Field({ label, value, error, onChange, placeholder, hint, feePayer, multiline, inputMode }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const common = {
    id,
    value,
    spellCheck: false,
    autoComplete: "off",
    autoCapitalize: "off",
    placeholder,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
  } as const;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-neutral-300">{label}</label>
      <div className="flex gap-2">
        {multiline ? (
          <textarea {...common} rows={3} onChange={(e) => onChange(e.target.value)} className={`${inputClass} resize-y break-all py-2`} />
        ) : (
          <input {...common} type="text" inputMode={inputMode} onChange={(e) => onChange(e.target.value)} className={inputClass} />
        )}
        {feePayer && (
          <button
            type="button"
            onClick={() => onChange(feePayer)}
            aria-label={`Use fee payer as ${label.toLowerCase()}`}
            title="Use the last result's fee payer"
            className={smallButton}
          >
            <UserRound className="size-4" aria-hidden />
            <span className="hidden sm:inline" aria-hidden>Use fee payer</span>
          </button>
        )}
      </div>
      {hint && <p id={hintId} className="text-xs text-neutral-500">{hint}</p>}
      {error && (
        <p id={errorId} className="text-xs text-red-400">
          <span aria-hidden>✕ </span>
          {error}
        </p>
      )}
    </div>
  );
}

export interface OverrideRowEditorProps {
  row: OverrideRow;
  position: number;
  errors: RowErrors;
  feePayer: string | null;
  onChange: (patch: Partial<Omit<OverrideRow, "id">>) => void;
  onRemove: () => void;
}

/** One override: kind select plus that kind's fields. */
export function OverrideRowEditor({ row, position, errors, feePayer, onChange, onRemove }: OverrideRowEditorProps) {
  const kindId = useId();
  const rawId = useId();
  const field = (f: RowField) => ({ error: errors[f] });

  return (
    <li className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={kindId} className="text-xs font-medium text-neutral-300">
            Override {position} kind
          </label>
          <select
            id={kindId}
            value={row.kind}
            onChange={(e) => onChange({ kind: e.target.value as OverrideKind })}
            className="min-h-11 rounded-lg border border-neutral-800 bg-neutral-900 px-3 text-sm text-neutral-100 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
          >
            {(Object.keys(KIND_LABEL) as OverrideKind[]).map((k) => (
              <option key={k} value={k}>{KIND_LABEL[k]}</option>
            ))}
          </select>
        </div>
        <button type="button" onClick={onRemove} className={smallButton}>
          <Trash2 className="size-4 text-red-400" aria-hidden />
          Remove<span className="sr-only"> override {position}</span>
        </button>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {row.kind === "sol" && (
          <>
            <Field {...field("address")} label="Address" value={row.address} onChange={(address) => onChange({ address })} feePayer={feePayer} placeholder="Base58 address" />
            <Field {...field("amount")} label="Balance (SOL)" value={row.amount} onChange={(amount) => onChange({ amount })} inputMode="decimal" placeholder="10.5" hint="Set as lamports; up to 9 decimal places." />
          </>
        )}

        {row.kind === "token" && (
          <>
            <Field {...field("owner")} label="Owner" value={row.owner} onChange={(owner) => onChange({ owner })} feePayer={feePayer} placeholder="Wallet that owns the token account" />
            <Field {...field("mint")} label="Mint" value={row.mint} onChange={(mint) => onChange({ mint })} placeholder="Token mint address" />
            <Field
              {...field("amount")}
              label={row.rawUnits ? "Balance (raw units)" : "Balance (tokens)"}
              value={row.amount}
              onChange={(amount) => onChange({ amount })}
              inputMode={row.rawUnits ? "numeric" : "decimal"}
              placeholder={row.rawUnits ? "1000000" : "1000"}
            />
            <div className="flex flex-col gap-2">
              {!row.rawUnits && (
                <Field {...field("decimals")} label="Decimals" value={row.decimals} onChange={(decimals) => onChange({ decimals })} inputMode="numeric" hint="USDC and USDT use 6." />
              )}
              <label htmlFor={rawId} className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-neutral-300">
                <input id={rawId} type="checkbox" checked={row.rawUnits} onChange={(e) => onChange({ rawUnits: e.target.checked })} className="size-4 accent-violet-500" />
                Enter raw units (u64) instead of tokens
              </label>
            </div>
          </>
        )}

        {row.kind === "data" && (
          <>
            <Field {...field("address")} label="Address" value={row.address} onChange={(address) => onChange({ address })} feePayer={feePayer} placeholder="Base58 address" />
            <Field {...field("owner")} label="Owner program (optional)" value={row.owner} onChange={(owner) => onChange({ owner })} placeholder="Keeps the current owner when empty" />
            <div className="md:col-span-2">
              <Field {...field("dataBase64")} label="Data (base64)" value={row.dataBase64} onChange={(dataBase64) => onChange({ dataBase64 })} multiline placeholder="AQIDBA==" hint="Replaces the account's whole data." />
            </div>
          </>
        )}
      </div>
    </li>
  );
}
