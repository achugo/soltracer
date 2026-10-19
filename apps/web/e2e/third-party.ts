import { existsSync, readFileSync } from "node:fs";

/**
 * Third-party program binaries and IDLs aren't committed (see THIRD_PARTY_NOTICES.md); the engine's
 * recordings refer to them by hash and they live in a local, gitignored cache. Specs that replay
 * such recordings run when the cache has them and are skipped, with this reason, when it doesn't.
 */
export const THIRD_PARTY_SKIP_REASON =
  "needs third-party fixtures (program binaries/IDLs) from the local cache: run `pnpm --filter @soltracer/engine fixtures fetch-third-party`";

const fixtures = new URL("../../engine/test/fixtures/", import.meta.url);
const dirs = [new URL("blobs/", fixtures), new URL("third-party/", fixtures)];

/** Whether every blob the given engine recordings (e.g. "jupiter-slippage-6001.sim.json") refer to is present. */
export function recordingsAvailable(...files: string[]): boolean {
  return files.every((file) => {
    const text = readFileSync(new URL(`sandbox/${file}`, fixtures), "utf8");
    return [...text.matchAll(/"@blob:([0-9a-f]{64})"/g)].every(([, hash]) => dirs.some((d) => existsSync(new URL(`${hash}.b64.gz`, d))));
  });
}
