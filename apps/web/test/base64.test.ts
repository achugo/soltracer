import { describe, expect, it } from "vitest";
import { base64ToBytes } from "../lib/base64.ts";

describe("base64ToBytes", () => {
  it("decodes padded and unpadded-length base64", () => {
    expect(base64ToBytes("AQID")).toEqual(new Uint8Array([1, 2, 3]));
    expect(base64ToBytes("AQI=")).toEqual(new Uint8Array([1, 2]));
    expect(base64ToBytes("AQ==")).toEqual(new Uint8Array([1]));
    expect(base64ToBytes("/+8=")).toEqual(new Uint8Array([255, 239]));
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 256);
    expect(base64ToBytes(Buffer.from(bytes).toString("base64"))).toEqual(bytes);
  });

  it.each(["", "AQI", "AQ=", "AQID\n", "A B=", "-_8=", "AQ==AQ=="])("rejects %j", (value) => {
    expect(base64ToBytes(value)).toBeNull();
  });
});
