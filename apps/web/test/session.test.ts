import { sealData } from "iron-session";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { readSessionCookie, SESSION_TTL_SECONDS } from "../lib/session-cookie.ts";

const password = "p".repeat(32);
const publicKey = bs58.encode(new Uint8Array(32).fill(5));
const session = { publicKey, signedInAt: "2026-10-13T12:00:00.000Z" };

describe("readSessionCookie", () => {
  it("returns the session from a valid sealed cookie", async () => {
    const sealed = await sealData(session, { password, ttl: SESSION_TTL_SECONDS });
    expect(await readSessionCookie(sealed, password)).toEqual(session);
  });

  it("returns null for a missing, tampered or wrongly keyed cookie", async () => {
    const sealed = await sealData(session, { password, ttl: SESSION_TTL_SECONDS });
    expect(await readSessionCookie(undefined, password)).toBeNull();
    expect(await readSessionCookie(sealed.slice(0, -4) + "AAAA", password)).toBeNull();
    expect(await readSessionCookie(sealed, "q".repeat(32))).toBeNull();
  });

  it("returns null for a cookie without a valid session shape", async () => {
    expect(await readSessionCookie(await sealData({}, { password }), password)).toBeNull();
    expect(await readSessionCookie(await sealData({ publicKey: "x" }, { password }), password)).toBeNull();
  });
});
