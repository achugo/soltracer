// Test worker that answers each job with its input after a short delay.
import { parentPort } from "node:worker_threads";
parentPort.on("message", ({ id, input }) => {
  setTimeout(() => parentPort.postMessage({ id, ok: true, output: { echoed: input } }), 5);
});
