import { resolve } from "node:path";
import type { NextConfig } from "next";

// Both apps share the repo-root .env. Real env vars take precedence.
try {
  process.loadEnvFile(resolve(import.meta.dirname, "../../.env"));
} catch {
  // No .env file: rely on the process environment.
}

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Not "no-referrer": that makes Chrome send `Origin: null` on form POSTs, which the proxy refuses.
  { key: "Referrer-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@soltracer/shared"],
  headers: async () => [{ source: "/:path*", headers: securityHeaders }],
};

export default nextConfig;
