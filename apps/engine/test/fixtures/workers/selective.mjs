// Test worker that spins forever on "spin" and echoes anything else.
import { parentPort } from "node:worker_threads";
parentPort.on("message", ({ id, input }) => {
  if (input === "spin") for (;;) {
    // spin
  }
  parentPort.postMessage({ id, ok: true, output: { echoed: input } });
});
