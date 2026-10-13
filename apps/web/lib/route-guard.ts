const PUBLIC_PAGES = new Set(["/login"]);
// Logout is public so an expired session can still sign out cleanly; destroying nothing is a no-op.
const PUBLIC_API = new Set(["/api/auth/nonce", "/api/auth/verify", "/api/auth/logout"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const HOME_PATH = "/sandbox";

export type AccessDecision =
  | { type: "next" }
  | { type: "redirect"; to: string }
  | { type: "unauthorized" }
  | { type: "forbidden" };

export interface AccessRequest {
  pathname: string;
  search: string;
  method: string;
  host: string | null;
  origin: string | null;
  hasSession: boolean;
}

function sameOrigin(origin: string, host: string | null): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Pure routing decision for the proxy: who may see what. */
export function decideAccess(req: AccessRequest): AccessDecision {
  if (!SAFE_METHODS.has(req.method) && req.origin !== null && !sameOrigin(req.origin, req.host)) {
    return { type: "forbidden" };
  }
  if (PUBLIC_PAGES.has(req.pathname)) {
    return req.hasSession ? { type: "redirect", to: HOME_PATH } : { type: "next" };
  }
  if (PUBLIC_API.has(req.pathname) || req.hasSession) return { type: "next" };
  if (req.pathname.startsWith("/api/")) return { type: "unauthorized" };
  return { type: "redirect", to: `/login?next=${encodeURIComponent(req.pathname + req.search)}` };
}

/** Only same-site absolute paths survive; everything else goes home. */
export function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return HOME_PATH;
  if (value === "/login" || value.startsWith("/login?") || value.startsWith("/login/")) return HOME_PATH;
  return value;
}
