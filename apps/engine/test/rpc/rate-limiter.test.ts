import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "../../src/rpc/rate-limiter.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Largest number of grants inside any window of `windowMs` (half-open). */
function maxInWindow(times: number[], windowMs: number): number {
  let max = 0;
  for (const start of times) max = Math.max(max, times.filter((t) => t >= start && t < start + windowMs).length);
  return max;
}

describe("createRateLimiter", () => {
  it("grants a burst up to the limit immediately", async () => {
    const limiter = createRateLimiter({ limit: 10, windowMs: 1000 });
    const granted: number[] = [];
    for (let i = 0; i < 10; i++) void limiter.take().then(() => granted.push(Date.now()));
    await vi.advanceTimersByTimeAsync(0);
    expect(granted).toHaveLength(10);
  });

  it("never grants more than 10 in any 1-second window, in FIFO order", async () => {
    const limiter = createRateLimiter({ limit: 10, windowMs: 1000 });
    const times: number[] = [];
    const order: number[] = [];
    for (let i = 0; i < 35; i++) {
      void limiter.take().then(() => {
        times.push(Date.now());
        order.push(i);
      });
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(times).toHaveLength(35);
    expect(maxInWindow(times, 1000)).toBe(10);
    expect(order).toEqual([...Array(35).keys()]);
    // 35 calls at 10/s need at least three full windows after the first burst.
    expect(Math.max(...times) - Math.min(...times)).toBeGreaterThanOrEqual(3000);
  });

  it("keeps the limit across calls spread out in time", async () => {
    const limiter = createRateLimiter({ limit: 10, windowMs: 1000 });
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      void limiter.take().then(() => times.push(Date.now()));
      await vi.advanceTimersByTimeAsync(37);
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(times).toHaveLength(40);
    expect(maxInWindow(times, 1000)).toBeLessThanOrEqual(10);
  });

  it("rejects a waiting call when its signal aborts, without blocking the queue", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
    await limiter.take();
    const controller = new AbortController();
    const waiting = limiter.take(controller.signal);
    const next = limiter.take();
    controller.abort();
    await expect(waiting).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(next).resolves.toBeUndefined();
  });
});
