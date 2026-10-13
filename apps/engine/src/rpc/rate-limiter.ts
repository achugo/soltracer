/**
 * Sliding-window limiter: at most `limit` grants in any `windowMs` window, served FIFO.
 * Stricter than a token bucket of the same rate, which can allow up to 2x in a window
 * after a burst; Helius counts requests per second, so this is the safe shape.
 */
export interface RateLimiter {
  /** Resolves when the caller may send one request. Rejects if `signal` aborts first. */
  take(signal?: AbortSignal): Promise<void>;
}

interface Waiter {
  resolve: () => void;
}

const abortError = () => new Error("RPC request aborted while waiting for the rate limiter");

export function createRateLimiter({ limit, windowMs }: { limit: number; windowMs: number }): RateLimiter {
  const grants: number[] = [];
  const queue: Waiter[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function pump(): void {
    timer = null;
    for (let waiter = queue[0]; waiter !== undefined; waiter = queue[0]) {
      const now = Date.now();
      while (grants[0] !== undefined && grants[0] <= now - windowMs) grants.shift();
      const oldest = grants[0];
      if (grants.length >= limit && oldest !== undefined) {
        timer = setTimeout(pump, oldest + windowMs - now);
        return;
      }
      queue.shift();
      grants.push(now);
      waiter.resolve();
    }
  }

  return {
    take(signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        const onAbort = () => {
          const index = queue.indexOf(waiter);
          if (index === -1) return;
          queue.splice(index, 1);
          reject(abortError());
        };
        const waiter: Waiter = {
          resolve: () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
        };
        queue.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (timer === null) pump();
      });
    },
  };
}
