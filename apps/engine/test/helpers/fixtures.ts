import bs58 from "bs58";
import nacl from "tweetnacl";
import type { EngineConfig } from "../../src/config.ts";

export const ENGINE_TOKEN = "e".repeat(40);

/** Deterministic throwaway keypairs; never real wallets. */
export function testKeypair(seedByte: number) {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte));
  return {
    publicKey: bs58.encode(kp.publicKey),
    sign: (message: string) =>
      bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)),
  };
}

export const allowed = testKeypair(1);
export const stranger = testKeypair(2);

export const testConfig: EngineConfig = {
  HELIUS_API_KEY: "test-helius-key",
  HELIUS_RPC_URL: "https://rpc.example.com/?api-key=test-helius-key",
  HELIUS_WSS_URL: "wss://rpc.example.com/?api-key=test-helius-key",
  DATABASE_URL: "postgres://u:p@127.0.0.1:5432/unused",
  ALLOWLIST: [allowed.publicKey],
  ENGINE_TOKEN,
  ENGINE_PORT: 4000,
};
