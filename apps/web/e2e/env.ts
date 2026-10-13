import bs58 from "bs58";
import nacl from "tweetnacl";

/** Throwaway keypairs from fixed seeds. Never real wallets. */
export function testWallet(seedByte: number) {
  const seed = new Uint8Array(32).fill(seedByte);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return {
    seed,
    publicKey: kp.publicKey,
    address: bs58.encode(kp.publicKey),
    sign: (message: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)),
  };
}

export const allowedWallet = testWallet(11);
export const strangerWallet = testWallet(12);

export const E2E_ENGINE_PORT = 4100;
export const E2E_WEB_PORT = 3100;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_WEB_PORT}`;
export const E2E_DOMAIN = `127.0.0.1:${E2E_WEB_PORT}`;

/** Env for both servers. Dummy Helius values: Phase 0 never calls RPC. */
export const e2eEnv = {
  HELIUS_API_KEY: "e2e-dummy-helius-key",
  HELIUS_RPC_URL: "https://rpc.invalid/?api-key=e2e-dummy-helius-key",
  HELIUS_WSS_URL: "wss://rpc.invalid/?api-key=e2e-dummy-helius-key",
  DATABASE_URL:
    process.env.E2E_DATABASE_URL ?? "postgres://soltracer:soltracer@127.0.0.1:5432/soltracer",
  ALLOWLIST: allowedWallet.address,
  ENGINE_TOKEN: "e2e-engine-token-".padEnd(48, "x"),
  ENGINE_PORT: String(E2E_ENGINE_PORT),
  ENGINE_URL: `http://127.0.0.1:${E2E_ENGINE_PORT}`,
  SESSION_SECRET: "e2e-session-secret-".padEnd(48, "y"),
  APP_HOSTS: `127.0.0.1:${E2E_WEB_PORT}`,
};
