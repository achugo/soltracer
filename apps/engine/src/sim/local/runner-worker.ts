// Worker entry: runs LiteSVM off the main thread. Loaded by Node with native TypeScript stripping,
// so it may only use type-erasable syntax and must import its dependencies by file path.
import { parentPort } from "node:worker_threads";
import { runLocal, type LocalRunInput } from "./runner.ts";

parentPort?.on("message", ({ id, input }: { id: number; input: LocalRunInput }) => {
  try {
    parentPort?.postMessage({ id, ok: true, output: runLocal(input) });
  } catch (err) {
    parentPort?.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
