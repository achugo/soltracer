import { formatUnits } from "@soltracer/shared/simulation";

export const LAMPORTS_DECIMALS = 9;

/** `AbcD…wxYz` for addresses and other long ids; short values pass through. */
export function shortAddress(value: string, edge = 4): string {
  return value.length <= edge * 2 + 1 ? value : `${value.slice(0, edge)}…${value.slice(-edge)}`;
}

/** Adds thousands separators to an integer string (keeps a leading minus). */
export function groupDigits(raw: string): string {
  const negative = raw.startsWith("-");
  const digits = negative ? raw.slice(1) : raw;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

export function lamportsToSol(lamports: string): string {
  return formatUnits(lamports, LAMPORTS_DECIMALS);
}

export interface SignedAmount {
  direction: "up" | "down" | "none";
  /** With an explicit `+` or `−` (U+2212) sign; zero has none. */
  text: string;
}

/** Formats a signed integer delta with `decimals` places and an explicit sign. */
export function formatDelta(delta: string, decimals: number): SignedAmount {
  const value = formatUnits(delta, decimals);
  if (value === "0") return { direction: "none", text: "0" };
  if (value.startsWith("-")) return { direction: "down", text: `−${value.slice(1)}` };
  return { direction: "up", text: `+${value}` };
}

/** `0x1771` style; negative codes keep their sign. */
export function toHex(code: number): string {
  return code < 0 ? `-0x${(-code).toString(16)}` : `0x${code.toString(16)}`;
}

export function compactCu(units: number): string {
  if (units >= 1_000_000) return `${+(units / 1_000_000).toFixed(2)}M`;
  if (units >= 1_000) return `${+(units / 1_000).toFixed(1)}k`;
  return String(units);
}
