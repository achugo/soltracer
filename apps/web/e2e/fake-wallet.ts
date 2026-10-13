import type { Page } from "@playwright/test";

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/**
 * Registers a Wallet Standard wallet in the page that signs with the given test key
 * via WebCrypto Ed25519. It cannot sign transactions.
 */
export async function installFakeWallet(
  page: Page,
  opts: { name: string; seed: Uint8Array; publicKey: Uint8Array; address: string },
) {
  await page.addInitScript(
    ({ name, address, publicKey, jwk }) => {
      const pubkey = new Uint8Array(publicKey);
      const chains = ["solana:mainnet", "solana:devnet"] as const;
      const account = { address, publicKey: pubkey, chains, features: ["solana:signMessage"] as const, label: "e2e" };
      const listeners = new Set<(props: { accounts: (typeof account)[] }) => void>();
      let accounts: (typeof account)[] = [];
      const keyPromise = crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);

      const wallet = {
        version: "1.0.0" as const,
        name,
        icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4=",
        chains,
        get accounts() {
          return accounts;
        },
        features: {
          "standard:connect": {
            version: "1.0.0",
            connect: async () => {
              accounts = [account];
              listeners.forEach((l) => l({ accounts }));
              return { accounts };
            },
          },
          "standard:disconnect": {
            version: "1.0.0",
            disconnect: async () => {
              accounts = [];
              listeners.forEach((l) => l({ accounts }));
            },
          },
          "standard:events": {
            version: "1.0.0",
            on: (_event: string, listener: (props: { accounts: (typeof account)[] }) => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          },
          "solana:signMessage": {
            version: "1.0.0",
            signMessage: async (...inputs: { message: Uint8Array }[]) => {
              const key = await keyPromise;
              return Promise.all(
                inputs.map(async ({ message }) => ({
                  signedMessage: message,
                  signature: new Uint8Array(await crypto.subtle.sign("Ed25519", key, new Uint8Array(message))),
                })),
              );
            },
          },
          "solana:signTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy", 0],
            signTransaction: async () => {
              throw new Error("The e2e wallet does not sign transactions");
            },
          },
        },
      };

      const register = ({ register }: { register: (w: unknown) => void }) => register(wallet);
      window.addEventListener("wallet-standard:app-ready", (e) =>
        register((e as CustomEvent<{ register: (w: unknown) => void }>).detail),
      );
      window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
    },
    {
      name: opts.name,
      address: opts.address,
      publicKey: [...opts.publicKey],
      jwk: { kty: "OKP", crv: "Ed25519", d: b64url(opts.seed), x: b64url(opts.publicKey) },
    },
  );
}
