import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { missingBlobs } from "../../src/rpc/replay.ts";

/**
 * Third-party program binaries and Anchor IDLs are not committed (see THIRD_PARTY_NOTICES.md).
 * Recordings refer to them by content hash; they live in a local, gitignored cache. Tests that
 * replay them run when the cache has them and are skipped, with this reason, when it doesn't.
 */
export const COMMITTED_BLOB_DIR = fileURLToPath(new URL("../fixtures/blobs", import.meta.url));
export const THIRD_PARTY_DIR = fileURLToPath(new URL("../fixtures/third-party", import.meta.url));
export const BLOB_DIRS = [COMMITTED_BLOB_DIR, THIRD_PARTY_DIR] as const;

export const JUPITER_IDL_FIXTURE = `${THIRD_PARTY_DIR}/jupiter-v6.idl.json`;

export const THIRD_PARTY_SKIP_REASON =
  "needs third-party fixtures (program binaries/IDLs) from the local cache: run `pnpm --filter @soltracer/engine fixtures fetch-third-party`";

const fixturePath = (relative: string) => fileURLToPath(new URL(`../fixtures/${relative}`, import.meta.url));

/** Whether every blob a recording (or part of one) refers to is available. */
export function blobsAvailable(text: string): boolean {
  return missingBlobs(text, BLOB_DIRS).length === 0;
}

/** Whether a recording under test/fixtures (e.g. "sandbox/x.sim.json") can be replayed here. */
export function recordingAvailable(relative: string): boolean {
  return blobsAvailable(readFileSync(fixturePath(relative), "utf8"));
}

/** Whether one engine's side of a comparison recording can be replayed here. */
export function comparisonAvailable(name: string, engine: "rpc" | "local"): boolean {
  const recording = JSON.parse(readFileSync(fixturePath(`sandbox/${name}.cmp.json`), "utf8")) as Record<string, unknown>;
  return blobsAvailable(JSON.stringify(recording[engine]));
}

export const jupiterIdlAvailable = (): boolean => existsSync(JUPITER_IDL_FIXTURE);

/** The recorded getAccountInfo of Jupiter v6's on-chain IDL account (`fixtures record-idl`); null when not in the cache. */
export function loadJupiterIdlFixture(): { program: string; idlAddress: string; text: string } | null {
  if (!jupiterIdlAvailable()) return null;
  const text = readFileSync(JUPITER_IDL_FIXTURE, "utf8");
  const parsed = JSON.parse(text) as { program: string; idlAddress: string };
  return { program: parsed.program, idlAddress: parsed.idlAddress, text };
}

/** The raw bytes of Jupiter v6's IDL account; null when not in the cache. */
export function jupiterIdlAccountData(): Uint8Array | null {
  const fixture = loadJupiterIdlFixture();
  if (!fixture) return null;
  const parsed = JSON.parse(fixture.text) as { rpc: { response: { result: { value: { data: [string, string] } } } }[] };
  return new Uint8Array(Buffer.from(parsed.rpc[0]?.response.result.value.data[0] ?? "", "base64"));
}

/** For tests that are skipped when a cached value is missing: the value, known to be present. */
export function present<T>(value: T | null): T {
  if (value === null) throw new Error(THIRD_PARTY_SKIP_REASON);
  return value;
}
