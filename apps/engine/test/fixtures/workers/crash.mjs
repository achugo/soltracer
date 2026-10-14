// Test worker that dies on its first job.
import { parentPort } from "node:worker_threads";
parentPort.on("message", () => {
  throw new Error("worker crashed");
});
