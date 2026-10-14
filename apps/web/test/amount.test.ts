import { describe, expect, it } from "vitest";
import { parseDecimalAmount, parseDecimals, U64_MAX } from "../lib/amount.ts";

const raw = (input: string, decimals: number) => {
  const r = parseDecimalAmount(input, decimals);
  if (!r.ok) throw new Error(`expected ok for ${input}: ${r.error}`);
  return r.raw;
};
const error = (input: string, decimals: number) => {
  const r = parseDecimalAmount(input, decimals);
  if (r.ok) throw new Error(`expected an error for ${input}`);
  return r.error;
};

describe("parseDecimalAmount", () => {
  it("converts SOL to lamports exactly", () => {
    expect(raw("1", 9)).toBe("1000000000");
    expect(raw("1.5", 9)).toBe("1500000000");
    expect(raw("0.000000001", 9)).toBe("1");
    expect(raw(" 2.25 ", 9)).toBe("2250000000");
  });

  it("is exact where floats are not", () => {
    // 0.1 + 0.2 style values and 0.29 * 1e9 = 289999999.99999994 in floating point.
    expect(raw("0.29", 9)).toBe("290000000");
    expect(raw("9007199254.740993", 9)).toBe("9007199254740993000");
  });

  it("accepts leading or trailing dots and zero", () => {
    expect(raw(".5", 6)).toBe("500000");
    expect(raw("5.", 6)).toBe("5000000");
    expect(raw("0", 6)).toBe("0");
    expect(raw("000012", 0)).toBe("12");
  });

  it("allows trailing zeros past the decimals", () => {
    expect(raw("1.5000000000", 9)).toBe("1500000000");
    expect(raw("7.000", 0)).toBe("7");
  });

  it("rejects too many decimal places", () => {
    expect(error("0.0000000001", 9)).toBe("At most 9 decimal places");
    expect(error("1.1234567", 6)).toBe("At most 6 decimal places");
    expect(error("0.15", 1)).toBe("At most 1 decimal place");
    expect(error("1.5", 0)).toBe("Must be a whole number");
  });

  it("rejects negatives, signs, exponents, separators and junk", () => {
    expect(error("-1", 9)).toBe("Amount can't be negative");
    for (const bad of ["+1", "1e9", "1,000", "1 000", "abc", ".", "1.2.3", "0x10", "Infinity"]) {
      expect(parseDecimalAmount(bad, 9).ok).toBe(false);
    }
    expect(error("", 9)).toBe("Enter an amount");
    expect(error("   ", 9)).toBe("Enter an amount");
  });

  it("handles u64 max and rejects anything above it", () => {
    expect(raw("18446744073709551615", 0)).toBe(U64_MAX.toString());
    expect(raw("18446744073.709551615", 9)).toBe("18446744073709551615");
    expect(raw("18446744073709.551615", 6)).toBe("18446744073709551615");
    expect(error("18446744073709551616", 0)).toBe("Too large: exceeds the u64 maximum");
    expect(error("18446744073.709551616", 9)).toBe("Too large: exceeds the u64 maximum");
    expect(error("18446744074", 9)).toBe("Too large: exceeds the u64 maximum");
  });

  it("rejects invalid decimals", () => {
    expect(parseDecimalAmount("1", -1).ok).toBe(false);
    expect(parseDecimalAmount("1", 1.5).ok).toBe(false);
    expect(parseDecimalAmount("1", 256).ok).toBe(false);
  });
});

describe("parseDecimals", () => {
  it("accepts 0 to 255", () => {
    expect(parseDecimals("0")).toBe(0);
    expect(parseDecimals(" 6 ")).toBe(6);
    expect(parseDecimals("255")).toBe(255);
  });

  it("rejects everything else", () => {
    for (const bad of ["", "256", "-1", "1.5", "6a", "1000"]) expect(parseDecimals(bad)).toBeNull();
  });
});
