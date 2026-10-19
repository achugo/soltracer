import {
  MAX_OVERRIDE_DATA_BYTES,
  MAX_OVERRIDES,
  overrideSchema,
  type Override,
} from "@soltracer/shared/simulation";
import { parseDecimalAmount, parseDecimals } from "./amount.ts";
import { LAMPORTS_DECIMALS } from "./format.ts";

export type OverrideKind = Override["kind"];

/**
 * One editable override. Every kind's fields live on the row so switching kind keeps what was typed.
 * - sol: `address`, `amount` (SOL)
 * - token: `owner`, `mint`, `amount` (whole tokens with `decimals`, or raw units when `rawUnits`)
 * - data: `address`, `dataBase64`, optional `owner`
 */
export interface OverrideRow {
  id: number;
  kind: OverrideKind;
  address: string;
  owner: string;
  mint: string;
  amount: string;
  decimals: string;
  rawUnits: boolean;
  dataBase64: string;
}

export type RowField = "address" | "owner" | "mint" | "amount" | "decimals" | "dataBase64";
export type RowErrors = Partial<Record<RowField, string>>;

export const DEFAULT_TOKEN_DECIMALS = "6";

export function emptyRow(id: number, kind: OverrideKind = "sol"): OverrideRow {
  return { id, kind, address: "", owner: "", mint: "", amount: "", decimals: DEFAULT_TOKEN_DECIMALS, rawUnits: false, dataBase64: "" };
}

/** Which fields a kind uses, in display order. */
export const KIND_FIELDS: Record<OverrideKind, readonly RowField[]> = {
  sol: ["address", "amount"],
  token: ["owner", "mint", "amount", "decimals"],
  data: ["address", "dataBase64", "owner"],
};

// Schema paths map onto form fields; amounts come from `amount` in the form.
const SCHEMA_FIELD: Record<string, RowField> = {
  address: "address",
  owner: "owner",
  mint: "mint",
  lamports: "amount",
  amount: "amount",
  dataBase64: "dataBase64",
};

export type RowResult = { ok: true; override: Override } | { ok: false; errors: RowErrors };

/** Converts one row to an override, validated with the shared `overrideSchema`. */
export function rowToOverride(row: OverrideRow): RowResult {
  const errors: RowErrors = {};
  let candidate: Record<string, unknown>;

  switch (row.kind) {
    case "sol": {
      const amount = parseDecimalAmount(row.amount, LAMPORTS_DECIMALS);
      if (!amount.ok) errors.amount = amount.error;
      candidate = { kind: "sol", address: row.address.trim(), lamports: amount.ok ? amount.raw : "0" };
      break;
    }
    case "token": {
      let raw = "0";
      if (row.rawUnits) {
        const amount = parseDecimalAmount(row.amount, 0);
        if (amount.ok) raw = amount.raw;
        else errors.amount = amount.error;
      } else {
        const decimals = parseDecimals(row.decimals);
        if (decimals === null) {
          errors.decimals = "Decimals must be a whole number from 0 to 255";
        } else {
          const amount = parseDecimalAmount(row.amount, decimals);
          if (amount.ok) raw = amount.raw;
          else errors.amount = amount.error;
        }
      }
      candidate = { kind: "token", owner: row.owner.trim(), mint: row.mint.trim(), amount: raw };
      break;
    }
    case "data": {
      const owner = row.owner.trim();
      candidate = {
        kind: "data",
        address: row.address.trim(),
        // Pasted base64 often wraps; whitespace is never part of the data.
        dataBase64: row.dataBase64.replace(/\s+/g, ""),
        ...(owner === "" ? {} : { owner }),
      };
      break;
    }
  }

  const parsed = overrideSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = SCHEMA_FIELD[String(issue.path[0])];
      // Amount errors from the converter are clearer than the schema's; keep the first per field.
      if (field && errors[field] === undefined) errors[field] = issue.message;
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (!parsed.success) return { ok: false, errors: { address: "Invalid override" } };
  return { ok: true, override: parsed.data };
}

export interface DataSize {
  bytes: number;
  limit: number;
  level: "ok" | "warn" | "over";
}

/** Base64 characters the shared schema allows across all data overrides. */
const MAX_DATA_BASE64_CHARS = Math.ceil(MAX_OVERRIDE_DATA_BYTES / 3) * 4;
const WARN_RATIO = 0.9;

/** Decoded size of all data overrides (data rows only). Warns from 90% of 1 MiB. */
export function dataSize(rows: readonly OverrideRow[]): DataSize {
  let chars = 0;
  let bytes = 0;
  for (const r of rows) {
    if (r.kind !== "data") continue;
    const b64 = r.dataBase64.replace(/\s+/g, "");
    chars += b64.length;
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    bytes += Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
  }
  // Over when either the decoded size or the schema's character budget is exceeded.
  const level =
    bytes > MAX_OVERRIDE_DATA_BYTES || chars > MAX_DATA_BASE64_CHARS
      ? "over"
      : bytes >= MAX_OVERRIDE_DATA_BYTES * WARN_RATIO
        ? "warn"
        : "ok";
  return { bytes, limit: MAX_OVERRIDE_DATA_BYTES, level };
}

export type BuildResult =
  | { ok: true; overrides: Override[] }
  | { ok: false; rowErrors: Record<number, RowErrors>; listError: string | null };

/** Validates every row and the list limits; returns the overrides to send, or what to fix. */
export function buildOverrides(rows: readonly OverrideRow[]): BuildResult {
  const overrides: Override[] = [];
  const rowErrors: Record<number, RowErrors> = {};
  for (const row of rows) {
    const r = rowToOverride(row);
    if (r.ok) overrides.push(r.override);
    else rowErrors[row.id] = r.errors;
  }
  let listError: string | null = null;
  if (rows.length > MAX_OVERRIDES) listError = `At most ${MAX_OVERRIDES} overrides`;
  else if (dataSize(rows).level === "over") listError = "Data overrides are limited to 1 MiB in total";
  if (listError !== null || Object.keys(rowErrors).length > 0) return { ok: false, rowErrors, listError };
  return { ok: true, overrides };
}

/**
 * Errors worth showing now: those on fields the user has typed in, or every error once they tried to
 * simulate. An empty, untouched row should not shout at the user.
 */
export function visibleErrors(
  rows: readonly OverrideRow[],
  rowErrors: Record<number, RowErrors>,
  showAll: boolean,
): Record<number, RowErrors> {
  const out: Record<number, RowErrors> = {};
  for (const row of rows) {
    const errors = rowErrors[row.id];
    if (!errors) continue;
    const shown: RowErrors = {};
    for (const [field, message] of Object.entries(errors) as [RowField, string][]) {
      if (showAll || row[field].trim() !== "") shown[field] = message;
    }
    if (Object.keys(shown).length > 0) out[row.id] = shown;
  }
  return out;
}

export type RowsAction =
  | { type: "add" }
  | { type: "remove"; id: number }
  | { type: "update"; id: number; patch: Partial<Omit<OverrideRow, "id">> };

export interface RowsState {
  rows: OverrideRow[];
  nextId: number;
}

export const initialRowsState: RowsState = { rows: [], nextId: 1 };

/** Editor state. Adding stops at MAX_OVERRIDES. */
export function rowsReducer(state: RowsState, action: RowsAction): RowsState {
  switch (action.type) {
    case "add":
      if (state.rows.length >= MAX_OVERRIDES) return state;
      return { rows: [...state.rows, emptyRow(state.nextId)], nextId: state.nextId + 1 };
    case "remove":
      return { ...state, rows: state.rows.filter((r) => r.id !== action.id) };
    case "update":
      return { ...state, rows: state.rows.map((r) => (r.id === action.id ? { ...r, ...action.patch } : r)) };
  }
}
