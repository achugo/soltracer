// Builds apps/web and fails if any secret value appears in what the browser can download:
// client JS/CSS (.next/static) and prerendered HTML/RSC payloads (.next/server/app).
// Needles are sentinel values injected into the build, plus real values from the root .env
// when it exists. Matching values are never printed.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

const root = resolve(import.meta.dirname, "..");
const webDir = join(root, "apps/web");
const SECRET_KEYS = ["HELIUS_API_KEY", "HELIUS_RPC_URL", "HELIUS_WSS_URL", "DATABASE_URL", "ENGINE_TOKEN", "SESSION_SECRET"];
const MIN_NEEDLE = 12;

const dotenvPath = join(root, ".env");
const dotenv = existsSync(dotenvPath) ? parseEnv(readFileSync(dotenvPath, "utf8")) : {};

// Keys missing from .env get sentinels so the build still has every secret set.
const sentinels = {
  HELIUS_API_KEY: "sentinel-helius-api-key-7f3a9c",
  HELIUS_RPC_URL: "https://sentinel-rpc.invalid/?api-key=sentinel-helius-api-key-7f3a9c",
  HELIUS_WSS_URL: "wss://sentinel-rpc.invalid/?api-key=sentinel-helius-api-key-7f3a9c",
  DATABASE_URL: "postgres://sentinel:sentinel-db-pass-41be@127.0.0.1:5432/sentinel",
  ENGINE_TOKEN: "sentinel-engine-token-0d8e2b6a91c4f735",
  SESSION_SECRET: "sentinel-session-secret-5ac1e09b7d24f683",
};
const buildEnv = { ...process.env };
for (const key of SECRET_KEYS) {
  if (!dotenv[key] && !process.env[key]) buildEnv[key] = sentinels[key];
}

const needles = new Map();
for (const key of SECRET_KEYS) {
  for (const value of [buildEnv[key], dotenv[key]]) {
    if (value && value.length >= MIN_NEEDLE) needles.set(value, key);
  }
  // The bare password inside DATABASE_URL is a secret too.
  try {
    const password = new URL(buildEnv[key] ?? "").password;
    if (key === "DATABASE_URL" && password.length >= 8) needles.set(password, `${key} password`);
  } catch {
    // Not a URL.
  }
}

console.log(`Building apps/web with ${needles.size} secret values to look for…`);
const build = spawnSync("pnpm", ["--filter", "@soltracer/web", "build"], { cwd: root, env: buildEnv, stdio: "inherit" });
if (build.status !== 0) {
  console.error("Build failed.");
  process.exit(1);
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const browserFiles = [
  ...walk(join(webDir, ".next/static")),
  ...[...walk(join(webDir, ".next/server/app"))].filter((p) => /\.(html|rsc|body|meta)$/.test(p)),
];
if (browserFiles.length === 0) {
  console.error("No build output found to scan.");
  process.exit(1);
}

const leaks = [];
for (const file of browserFiles) {
  const text = readFileSync(file, "utf8");
  for (const [needle, key] of needles) {
    if (text.includes(needle)) leaks.push(`${key} in ${file.slice(webDir.length + 1)}`);
  }
}

if (leaks.length > 0) {
  console.error(`Secret values found in the browser bundle:\n  ${leaks.join("\n  ")}`);
  process.exit(1);
}
console.log(`OK: scanned ${browserFiles.length} browser-facing files, no secret values found.`);
