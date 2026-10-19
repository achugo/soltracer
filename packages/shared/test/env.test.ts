import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { engineEnvSchema, parseAllowlist, webEnvSchema } from "../src/env.ts";

const key = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));
const token = "t".repeat(32);

const engineEnv = {
  HELIUS_API_KEY: "test-key",
  HELIUS_RPC_URL: "https://rpc.example.com/?api-key=test-key",
  HELIUS_WSS_URL: "wss://rpc.example.com/?api-key=test-key",
  DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db",
  ALLOWLIST: `${key(1)}, ${key(2)}`,
  ENGINE_TOKEN: token,
};

describe("parseAllowlist", () => {
  it("splits, trims, drops empties and dedupes", () => {
    expect(parseAllowlist(` ${key(1)} ,,${key(2)},${key(1)} `)).toEqual({
      ok: true,
      value: [key(1), key(2)],
    });
  });

  it("names every invalid entry", () => {
    expect(parseAllowlist(`${key(1)},nope,0bad`)).toEqual({ ok: false, invalid: ["nope", "0bad"] });
  });
});

describe("engineEnvSchema", () => {
  it("parses a valid env and defaults the port", () => {
    const env = engineEnvSchema.parse(engineEnv);
    expect(env.ALLOWLIST).toEqual([key(1), key(2)]);
    expect(env.ENGINE_PORT).toBe(4000);
  });

  it("coerces ENGINE_PORT from a string and rejects out-of-range ports", () => {
    expect(engineEnvSchema.parse({ ...engineEnv, ENGINE_PORT: "4001" }).ENGINE_PORT).toBe(4001);
    expect(engineEnvSchema.safeParse({ ...engineEnv, ENGINE_PORT: "70000" }).success).toBe(false);
  });

  it("requires at least one allowlisted wallet", () => {
    expect(engineEnvSchema.safeParse({ ...engineEnv, ALLOWLIST: " , " }).success).toBe(false);
  });

  it("rejects an invalid allowlist entry", () => {
    expect(engineEnvSchema.safeParse({ ...engineEnv, ALLOWLIST: "nope" }).success).toBe(false);
  });

  it("requires an ENGINE_TOKEN of at least 32 characters", () => {
    expect(engineEnvSchema.safeParse({ ...engineEnv, ENGINE_TOKEN: "short" }).success).toBe(false);
  });

  it("allows plain http only for a loopback RPC (local fakes in e2e)", () => {
    for (const url of ["http://127.0.0.1:4199", "http://localhost:4199/"]) {
      expect(engineEnvSchema.safeParse({ ...engineEnv, HELIUS_RPC_URL: url }).success).toBe(true);
    }
    for (const url of ["http://rpc.example.com", "http://127.0.0.1.evil.com", "http://10.0.0.1", "http://127.0.0.1:4199/?api-key=real"]) {
      expect(engineEnvSchema.safeParse({ ...engineEnv, HELIUS_RPC_URL: url }).success).toBe(false);
    }
  });

  it("requires https and wss Helius URLs", () => {
    expect(engineEnvSchema.safeParse({ ...engineEnv, HELIUS_RPC_URL: "http://rpc.example.com" }).success).toBe(false);
    expect(engineEnvSchema.safeParse({ ...engineEnv, HELIUS_WSS_URL: "ws://rpc.example.com" }).success).toBe(false);
  });

  it("requires a postgres DATABASE_URL", () => {
    expect(engineEnvSchema.safeParse({ ...engineEnv, DATABASE_URL: "mysql://x" }).success).toBe(false);
  });
});

describe("webEnvSchema", () => {
  it("parses a valid env and defaults ENGINE_URL and APP_HOSTS", () => {
    const env = webEnvSchema.parse({ SESSION_SECRET: "s".repeat(32), ENGINE_TOKEN: token });
    expect(env.ENGINE_URL).toBe("http://127.0.0.1:4000");
    expect(env.APP_HOSTS).toEqual(["127.0.0.1:3000", "localhost:3000"]);
  });

  it("parses APP_HOSTS as a trimmed, lowercased, deduped list", () => {
    const env = webEnvSchema.parse({
      SESSION_SECRET: "s".repeat(32),
      ENGINE_TOKEN: token,
      APP_HOSTS: " 127.0.0.1:3000 , MyBox.tail1.ts.net,127.0.0.1:3000 ",
    });
    expect(env.APP_HOSTS).toEqual(["127.0.0.1:3000", "mybox.tail1.ts.net"]);
  });

  it("rejects an invalid or empty APP_HOSTS", () => {
    const base = { SESSION_SECRET: "s".repeat(32), ENGINE_TOKEN: token };
    expect(webEnvSchema.safeParse({ ...base, APP_HOSTS: "http://evil.com" }).success).toBe(false);
    expect(webEnvSchema.safeParse({ ...base, APP_HOSTS: " , " }).success).toBe(false);
  });

  it("requires a SESSION_SECRET of at least 32 characters", () => {
    expect(webEnvSchema.safeParse({ SESSION_SECRET: "short", ENGINE_TOKEN: token }).success).toBe(false);
  });
});
