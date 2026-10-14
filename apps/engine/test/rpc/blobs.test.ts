import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BLOB_MIN_BASE64, externalizeBlobs, resolveBlobs } from "../../src/rpc/replay.ts";

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
