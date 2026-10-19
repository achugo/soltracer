import { pubkeySchema } from "@soltracer/shared";

export const SESSION_WALLET_HEADER = "x-soltracer-wallet";

const PUBLIC_PATHS = new Set(["/health", "/auth/nonce", "/auth/verify"]);

/** Routes reachable before sign-in; everything else acts on behalf of a session wallet. */
export function needsSessionWallet(url: string): boolean {
  return !PUBLIC_PATHS.has(url.split("?")[0] ?? url);
}

export type WalletCheck = "ok" | "missing" | "not-allowlisted";

/** Re-checks the session's wallet on every call, so removing it from ALLOWLIST takes effect at once. */
export function checkSessionWallet(header: string | string[] | undefined, allowlist: readonly string[]): WalletCheck {
  const wallet = pubkeySchema.safeParse(header);
  if (!wallet.success) return "missing";
  return allowlist.includes(wallet.data) ? "ok" : "not-allowlisted";
}
