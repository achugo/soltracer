import { Worker } from "node:worker_threads";
import { LocalLoadError } from "./loader.ts";

/** The worker that runs LiteSVM. */
export const LOCAL_RUNNER_WORKER = new URL("./runner-worker.ts", import.meta.url);

export interface WorkerPool<I, O> {
  /** Runs one job; rejects with LocalLoadError on timeout, crash or a job error. */
  run(input: I): Promise<O>;
  close(): Promise<void>;
}

interface Job<I, O> {
  id: number;
  input: I;
  resolve: (output: O) => void;
  reject: (err: Error) => void;
}

interface Slot<I, O> {
  worker: Worker;
  job: Job<I, O> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** After this many worker failures in a row (e.g. the worker can't even load) the pool stops respawning. */
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * A fixed-size pool of workers, one job each at a time. A job that runs past `timeoutMs` has its
 * worker terminated and replaced, so a stuck or crashed run can't block the event loop or the slot.
 * terminate() interrupts JavaScript only: a worker inside a long native LiteSVM call keeps its CPU
 * until that call returns (bounded by the compute limit), while its replacement serves new jobs.
 */
export function createWorkerPool<I, O>({ size, timeoutMs, workerUrl }: { size: number; timeoutMs: number; workerUrl: URL }): WorkerPool<I, O> {
  const queue: Job<I, O>[] = [];
  const slots: Slot<I, O>[] = [];
  let nextId = 0;
  let closed = false;
  let consecutiveFailures = 0;
  let broken: string | null = null;

  function finish(slot: Slot<I, O>): Job<I, O> | null {
    const job = slot.job;
    if (slot.timer) clearTimeout(slot.timer);
    slot.job = null;
    slot.timer = null;
    return job;
  }

  function replace(slot: Slot<I, O>, reason: string): void {
    finish(slot)?.reject(new LocalLoadError(reason));
    void slot.worker.terminate();
    if (closed) return;
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      broken = `The local runner keeps failing (${reason})`;
      for (const job of queue.splice(0)) job.reject(new LocalLoadError(broken));
      return;
    }
    slot.worker = spawn(slot);
    pump();
  }

  function spawn(slot: Slot<I, O>): Worker {
    const worker = new Worker(workerUrl);
    worker.on("message", (msg: { id: number; ok: boolean; output?: O; error?: string }) => {
      if (slot.worker !== worker || slot.job?.id !== msg.id) return;
      const job = finish(slot);
      consecutiveFailures = 0;
      if (msg.ok) job?.resolve(msg.output as O);
      else job?.reject(new LocalLoadError(`LiteSVM could not run this transaction: ${msg.error ?? "unknown error"}`));
      pump();
    });
    worker.on("error", (err) => {
      if (slot.worker === worker) replace(slot, `The local runner crashed: ${err.message}`);
    });
    worker.on("exit", (code) => {
      if (slot.worker === worker && !closed) replace(slot, `The local runner exited (code ${code})`);
    });
    return worker;
  }

  function pump(): void {
    for (const slot of slots) {
      if (slot.job || queue.length === 0) continue;
      const job = queue.shift() as Job<I, O>; // length checked above
      slot.job = job;
      slot.timer = setTimeout(() => replace(slot, `The local run timed out after ${timeoutMs} ms`), timeoutMs);
      try {
        slot.worker.postMessage({ id: job.id, input: job.input });
      } catch (err) {
        finish(slot)?.reject(new LocalLoadError(`Could not hand the run to a worker: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  for (let i = 0; i < size; i++) {
    const slot: Slot<I, O> = { worker: undefined as unknown as Worker, job: null, timer: null };
    slot.worker = spawn(slot);
    slots.push(slot);
  }

  return {
    run(input) {
      if (closed) return Promise.reject(new LocalLoadError("The local runner is shut down"));
      if (broken) return Promise.reject(new LocalLoadError(broken));
      return new Promise<O>((resolve, reject) => {
        queue.push({ id: nextId++, input, resolve, reject });
        pump();
      });
    },
    async close() {
      closed = true;
      for (const job of queue.splice(0)) job.reject(new LocalLoadError("The local runner is shut down"));
      await Promise.all(slots.map(async (slot) => {
        finish(slot)?.reject(new LocalLoadError("The local runner is shut down"));
        await slot.worker.terminate();
      }));
    },
  };
}
