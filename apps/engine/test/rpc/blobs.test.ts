import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BLOB_MIN_BASE64, externalizeBlobs, externalizeThirdParty, MissingBlobError, missingBlobs, resolveBlobs } from "../../src/rpc/replay.ts";

describe("fixture blobs", () => {
  const dir = mkdtempSync(join(tmpdir(), "blobs-"));
  const big = "A".repeat(BLOB_MIN_BASE64 + 4);

  it("stores large base64 once and restores it", () => {
    const out = externalizeBlobs({ a: [big, "base64"], b: { c: big }, small: "AQID" }, dir) as { a: string[]; b: { c: string } };
    expect(out.a[0]).toMatch(/^@blob:[0-9a-f]{64}$/);
    expect(out.b.c).toBe(out.a[0]);
    expect(resolveBlobs(out, dir)).toEqual({ a: [big, "base64"], b: { c: big }, small: "AQID" });
  });

  it("refuses references that are not a hex digest, and corrupt blobs", () => {
    expect(() => resolveBlobs("@blob:../../etc/passwd", dir)).toThrow(/Bad blob reference/);
    const fake = "0".repeat(64);
    writeFileSync(join(dir, `${fake}.b64.gz`), gzipSync("not the content"));
    expect(() => resolveBlobs(`@blob:${fake}`, dir)).toThrow(/corrupt/);
  });
});

describe("third-party material in recordings", () => {
  const committed = mkdtempSync(join(tmpdir(), "committed-"));
  const local = mkdtempSync(join(tmpdir(), "third-party-"));
  const UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
  const PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

  /** An Anchor IDL account: 44-byte header with the length at 40, then zlib JSON. */
  function idlAccount(json: unknown): string {
    const body = deflateSync(Buffer.from(JSON.stringify(json)));
    const header = Buffer.alloc(44);
    header.writeUInt32LE(body.length, 40);
    return b64(Buffer.concat([header, body]));
  }

  const binary = b64(new Uint8Array(4096).fill(7));
  const programAccount = b64(new Uint8Array(36).fill(2)); // points at its programdata; not code
  const recording = {
    rpc: [
      { response: { result: { value: [
        { data: [binary, "base64"], owner: UPGRADEABLE, executable: false },
        { data: [programAccount, "base64"], owner: UPGRADEABLE, executable: true },
        { data: [idlAccount({ instructions: [] }), "base64"], owner: PROGRAM },
        { data: ["AQID", "base64"], owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
      ] } } },
    ],
  };

  it("moves program binaries and IDLs, whatever their size, out of a recording; leaves chain state", () => {
    const out = externalizeThirdParty(recording, local) as typeof recording;
    const [code, program, idl, state] = out.rpc[0]?.response.result.value ?? [];
    expect(code?.data[0]).toMatch(/^@blob:[0-9a-f]{64}$/);
    expect(idl?.data[0]).toMatch(/^@blob:[0-9a-f]{64}$/);
    expect(program?.data[0]).toBe(programAccount);
    expect(state?.data[0]).toBe("AQID");
    expect(externalizeThirdParty(out, local)).toEqual(out); // already externalized: unchanged
    expect(resolveBlobs(out, [committed, local])).toEqual(recording);
  });

  it("looks in every folder, and names a missing blob instead of failing obscurely", () => {
    const out = externalizeThirdParty(recording, local);
    const text = JSON.stringify(out);
    expect(missingBlobs(text, [committed, local])).toEqual([]);
    expect(missingBlobs(text, [committed])).toHaveLength(2);
    expect(() => resolveBlobs(out, [committed])).toThrow(MissingBlobError);
  });
});
