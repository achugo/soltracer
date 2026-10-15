import { describe, expect, it } from "vitest";
import { frameTexts, loadStreamFixture } from "../helpers/stream-fixtures.ts";

describe("recorded stream fixture (jupiter-mentions)", () => {
  const fx = loadStreamFixture("jupiter-mentions");
  const notifications = fx.frames.filter((f) => (f as { method?: string }).method === "logsNotification") as {
    params: { subscription: bigint; result: { context: { slot: bigint }; value: { signature: string; err: unknown; logs: string[] } } };
  }[];

  it("starts with the subscription confirmation, then notifications for that subscription", () => {
    const confirmation = fx.frames[0] as { id: bigint; result: bigint }; // integers parse as BigInt, as on the wire
    expect(confirmation.id).toBe(1n);
    expect(notifications.length).toBeGreaterThanOrEqual(12);
    for (const n of notifications) {
      expect(n.params.subscription).toBe(confirmation.result);
      expect(n.params.result.value.logs.length).toBeGreaterThan(0);
    }
  });

  it("includes failures, and its success and failure each have a recorded getTransaction", () => {
    expect(notifications.some((n) => n.params.result.value.err !== null)).toBe(true);
    const byMethod = (m: string) => fx.rpc.filter((r) => r.method === m);
    const txs = byMethod("getTransaction").map((r) => (r.params as [string])[0]);
    expect(txs).toEqual([fx.succeeded, fx.failed]);
    const failedNotification = notifications.find((n) => n.params.result.value.signature === fx.failed);
    expect(failedNotification?.params.result.value.err).not.toBeNull();
    expect(byMethod("getSignaturesForAddress")).toHaveLength(1);
  });

  it("re-serializes frames with exact integers", () => {
    const text = frameTexts(fx)[1] ?? "";
    expect(text).toMatch(/"slot":\d{9}/);
    expect(text).not.toContain('"slot":"');
  });
});
