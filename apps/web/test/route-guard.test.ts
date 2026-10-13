import { describe, expect, it } from "vitest";
import { decideAccess, safeNextPath } from "../lib/route-guard.ts";

const base = { method: "GET", host: "127.0.0.1:3000", origin: null, search: "" };

describe("decideAccess", () => {
  it("redirects signed-out page requests to /login with the return path", () => {
    expect(decideAccess({ ...base, pathname: "/stream", search: "?x=1", hasSession: false })).toEqual({
      type: "redirect",
      to: "/login?next=%2Fstream%3Fx%3D1",
    });
    expect(decideAccess({ ...base, pathname: "/", hasSession: false })).toEqual({
      type: "redirect",
      to: "/login?next=%2F",
    });
  });

  it("returns 401 for signed-out API requests instead of redirecting", () => {
    expect(decideAccess({ ...base, pathname: "/api/anything", hasSession: false })).toEqual({ type: "unauthorized" });
  });

  it("lets anyone reach /login and the sign-in API", () => {
    for (const pathname of ["/login", "/api/auth/nonce", "/api/auth/verify", "/api/auth/logout"]) {
      expect(decideAccess({ ...base, pathname, hasSession: false })).toEqual({ type: "next" });
    }
  });

  it("does not treat lookalike paths as public", () => {
    for (const pathname of ["/login-x", "/api/auth/nonce/x", "/api/auth/verifyx"]) {
      expect(decideAccess({ ...base, pathname, hasSession: false }).type).not.toBe("next");
    }
  });

  it("sends signed-in users away from /login", () => {
    expect(decideAccess({ ...base, pathname: "/login", hasSession: true })).toEqual({ type: "redirect", to: "/sandbox" });
  });

  it("lets signed-in users through", () => {
    expect(decideAccess({ ...base, pathname: "/sandbox", hasSession: true })).toEqual({ type: "next" });
  });

  it("lets an expired session sign out but not cross-origin", () => {
    const req = { ...base, method: "POST", pathname: "/api/auth/logout", hasSession: false };
    expect(decideAccess(req)).toEqual({ type: "next" });
    expect(decideAccess({ ...req, origin: "https://evil.example" })).toEqual({ type: "forbidden" });
  });

  it("refuses cross-origin writes, even to public routes", () => {
    const req = { ...base, method: "POST", pathname: "/api/auth/verify", hasSession: false };
    expect(decideAccess({ ...req, origin: "https://evil.example" })).toEqual({ type: "forbidden" });
    expect(decideAccess({ ...req, origin: "not a url" })).toEqual({ type: "forbidden" });
    expect(decideAccess({ ...req, origin: "http://127.0.0.1:3000" })).toEqual({ type: "next" });
  });
});

describe("safeNextPath", () => {
  it("keeps same-site paths with query and hash", () => {
    expect(safeNextPath("/stream?x=1")).toBe("/stream?x=1");
    expect(safeNextPath("/runs/abc#node-3")).toBe("/runs/abc#node-3");
  });

  it("falls back to /sandbox for anything that could leave the site or loop", () => {
    for (const value of [
      null,
      "",
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\u007f/evil.example",
      "/.//evil.example",
      "/a/..//evil.example",
      "/%2e//evil.example",
      "/x/../login",
      "/login",
      "/login?next=/x",
      "/login#x",
      "stream",
    ]) {
      expect(safeNextPath(value)).toBe("/sandbox");
    }
  });
});
