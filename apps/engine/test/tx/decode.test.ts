import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { decodeTransactionInput } from "../../src/tx/decode.ts";
import { loadOnChain } from "../helpers/sandbox-fixtures.ts";

const solTransfer = loadOnChain("sol-transfer");
const base64 = solTransfer.transaction[0];
const bytes = Buffer.from(base64, "base64");

describe("decodeTransactionInput", () => {
  it("decodes base64 and reports encoding, version, size and signed state", () => {
    const res = decodeTransactionInput(base64);
    if (!res.ok) throw new Error(res.error.message);
    expect(res.tx).toMatchObject({ encoding: "base64", version: 0, size: bytes.length, signed: true });
    expect(res.tx.wireBase64).toBe(base64);
  });

  it("decodes the same transaction from base58", () => {
    const res = decodeTransactionInput(bs58.encode(bytes));
    if (!res.ok) throw new Error(res.error.message);
    expect(res.tx).toMatchObject({ encoding: "base58", version: 0, size: bytes.length });
    expect(res.tx.wireBase64).toBe(base64);
  });

  it("ignores surrounding whitespace and line breaks", () => {
    const wrapped = `  ${base64.slice(0, 40)}\n${base64.slice(40)}  `;
    expect(decodeTransactionInput(wrapped).ok).toBe(true);
  });

  it("reports unsigned when every signature is zero", () => {
    const unsigned = Uint8Array.from(bytes);
    unsigned.fill(0, 1, 65);
    const res = decodeTransactionInput(Buffer.from(unsigned).toString("base64"));
    if (!res.ok) throw new Error(res.error.message);
    expect(res.tx.signed).toBe(false);
  });

  it("decodes v0 with lookups and v1 with its larger size", () => {
    const alt = decodeTransactionInput(loadOnChain("jupiter-swap-alt").transaction[0]);
    const v1 = decodeTransactionInput(loadOnChain("v1-transaction").transaction[0]);
    if (!alt.ok || !v1.ok) throw new Error("decode failed");
    expect(alt.tx.version).toBe(0);
    expect(alt.tx.lookups.length).toBeGreaterThan(0);
    expect(v1.tx.version).toBe(1);
    expect(v1.tx.lookups).toEqual([]);
    expect(v1.tx.size).toBe(2372);
  });

  it("says which encodings were tried and why each failed", () => {
    const res = decodeTransactionInput("this is not a transaction!");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("TX_DECODE_FAILED");
    expect(res.error.details).toEqual({
      tried: [
        { encoding: "base64", reason: expect.stringMatching(/not valid base64/i) },
        { encoding: "base58", reason: expect.stringMatching(/not valid base58/i) },
      ],
    });
  });

  it("reports a structural failure when the text decodes but the bytes are not a transaction", () => {
    const res = decodeTransactionInput(Buffer.from("hello world, not a tx").toString("base64"));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("TX_DECODE_FAILED");
    const tried = (res.error.details as { tried: { encoding: string; reason: string }[] }).tried;
    expect(tried.find((t) => t.encoding === "base64")?.reason).toMatch(/not a valid transaction/i);
  });

  it("rejects trailing bytes after a valid transaction", () => {
    const padded = Buffer.concat([bytes, Buffer.from([0, 0, 0])]).toString("base64");
    expect(decodeTransactionInput(padded).ok).toBe(false);
  });

  it("rejects a v0 transaction over 1232 bytes with TX_TOO_LARGE and its size", () => {
    const big = buildV0WithData(1300);
    const res = decodeTransactionInput(big);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("TX_TOO_LARGE");
    expect(res.error.details).toMatchObject({ version: 0, limit: 1232 });
  });

  it("accepts a v0 transaction just under the limit", () => {
    expect(decodeTransactionInput(buildV0WithData(900)).ok).toBe(true);
  });

  it("accepts a large v1 transaction pasted as base58 even when it also looks like base64", () => {
    // Find a size whose base58 form has a length divisible by 4, so it also passes the base64 check.
    for (let dataLength = 3800; dataLength < 3900; dataLength++) {
      const b58 = bs58.encode(Buffer.from(buildV1WithData(dataLength), "base64"));
      if (b58.length % 4 !== 0 || Buffer.from(b58, "base64").length <= 4096) continue;
      const res = decodeTransactionInput(b58);
      if (!res.ok) throw new Error(res.error.message);
      expect(res.tx).toMatchObject({ encoding: "base58", version: 1 });
      return;
    }
    throw new Error("no suitable size found");
  });

  it("rejects anything over 4096 bytes before trying to decode it", () => {
    const res = decodeTransactionInput(Buffer.alloc(4097, 1).toString("base64"));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("TX_TOO_LARGE");
  });
});

/** An unsigned v0 transaction with one memo-style instruction carrying `dataLength` bytes. */
function buildV0WithData(dataLength: number): string {
  return buildWithData(0, dataLength);
}

function buildV1WithData(dataLength: number): string {
  return buildWithData(1, dataLength);
}

function buildWithData(version: 0 | 1, dataLength: number): string {
  const message = pipe(
    createTransactionMessage({ version }),
    (m) => setTransactionMessageFeePayer(address("11111111111111111111111111111112"), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n },
        m,
      ),
    (m) =>
      appendTransactionMessageInstruction(
        { programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), data: new Uint8Array(dataLength) },
        m,
      ),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}
