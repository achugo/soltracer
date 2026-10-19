export const U64_MAX = 18_446_744_073_709_551_615n;

/** Token mints store decimals as a u8. */
export const MAX_DECIMALS = 255;

export type ParseAmountResult = { ok: true; raw: string } | { ok: false; error: string };

const DECIMAL = /^(\d*)(?:\.(\d*))?$/;

/**
 * Converts a decimal amount ("1.5") to raw integer units ("1500000" for 6 decimals) exactly, with no
 * floating point. Rejects signs, exponents, separators, extra decimal places and values above u64 max.
 * Trailing zeros past `decimals` are allowed, since they do not change the value.
 */
export function parseDecimalAmount(input: string, decimals: number): ParseAmountResult {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    return { ok: false, error: `Decimals must be a whole number from 0 to ${MAX_DECIMALS}` };
  }
  const value = input.trim();
  if (value === "") return { ok: false, error: "Enter an amount" };
  if (value.startsWith("-")) return { ok: false, error: "Amount can't be negative" };
  const match = DECIMAL.exec(value);
  const whole = match?.[1] ?? "";
  const rawFraction = match?.[2] ?? "";
  if (!match || (whole === "" && rawFraction === "")) {
    return { ok: false, error: decimals === 0 ? "Enter a whole number" : "Enter a number like 1.5" };
  }
  const fraction = rawFraction.replace(/0+$/, "");
  if (fraction.length > decimals) {
    return {
      ok: false,
      error: decimals === 0 ? "Must be a whole number" : `At most ${decimals} decimal place${decimals === 1 ? "" : "s"}`,
    };
  }
  const raw = BigInt(`${whole || "0"}${fraction.padEnd(decimals, "0")}`);
  if (raw > U64_MAX) return { ok: false, error: "Too large: exceeds the u64 maximum" };
  return { ok: true, raw: raw.toString() };
}

/** Parses a decimals field: a whole number from 0 to 255. Null when invalid. */
export function parseDecimals(input: string): number | null {
  const v = input.trim();
  if (!/^\d{1,3}$/.test(v)) return null;
  const n = Number(v);
  return n <= MAX_DECIMALS ? n : null;
}
