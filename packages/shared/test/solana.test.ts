import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { pubkeySchema, signatureSchema } from "../src/solana.ts";

const key = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));

describe("pubkeySchema", () => {
  it("accepts a base58 string that decodes to 32 bytes", () => {
    expect(pubkeySchema.safeParse(key(7)).success).toBe(true);
  });

  it("rejects strings that decode to the wrong length", () => {
    expect(pubkeySchema.safeParse(bs58.encode(new Uint8Array(31).fill(7))).success).toBe(false);
    expect(pubkeySchema.safeParse(bs58.encode(new Uint8Array(33).fill(7))).success).toBe(false);
  });

  it("rejects non-base58 characters", () => {
    expect(pubkeySchema.safeParse("0OIl" + key(7).slice(4)).success).toBe(false);
    expect(pubkeySchema.safeParse("").success).toBe(false);
  });
});

describe("signatureSchema", () => {
  it("accepts 64 bytes and rejects anything else", () => {
    expect(signatureSchema.safeParse(bs58.encode(new Uint8Array(64).fill(9))).success).toBe(true);
    expect(signatureSchema.safeParse(key(9)).success).toBe(false);
  });
});
