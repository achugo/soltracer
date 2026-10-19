// Test worker that never answers (simulates a run stuck in LiteSVM).
import { parentPort } from "node:worker_threads";
parentPort.on("message", () => {
  for (;;) {
    // spin
  }
});
