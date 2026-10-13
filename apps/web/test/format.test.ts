import { describe, expect, it } from "vitest";
import { compactCu, formatDelta, groupDigits, lamportsToSol, shortAddress, toHex } from "../lib/format.ts";

describe("format helpers", () => {
  it("shortens long values and keeps short ones", () => {
    expect(shortAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe("EPjF…Dt1v");
    expect(shortAddress("abc")).toBe("abc");
  });

  it("groups digits", () => {
    expect(groupDigits("1400000")).toBe("1,400,000");
    expect(groupDigits("-5000")).toBe("-5,000");
    expect(groupDigits("999")).toBe("999");
  });

  it("converts lamports to SOL", () => {
    expect(lamportsToSol("5241")).toBe("0.000005241");
    expect(lamportsToSol("1000000000")).toBe("1");
  });

  it("signs deltas explicitly", () => {
    expect(formatDelta("1500000", 6)).toEqual({ direction: "up", text: "+1.5" });
    expect(formatDelta("-100005000", 9)).toEqual({ direction: "down", text: "−0.100005" });
    expect(formatDelta("0", 9)).toEqual({ direction: "none", text: "0" });
  });

  it("formats error codes as hex", () => {
    expect(toHex(6001)).toBe("0x1771");
    expect(toHex(0)).toBe("0x0");
    expect(toHex(-2)).toBe("-0x2");
  });

  it("compacts compute units", () => {
    expect(compactCu(1_400_000)).toBe("1.4M");
    expect(compactCu(200_000)).toBe("200k");
    expect(compactCu(150)).toBe("150");
  });
});
