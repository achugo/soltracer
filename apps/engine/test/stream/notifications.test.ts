import { MAX_EVENT_LOG_CHARS, MAX_EVENT_LOGS } from "@soltracer/shared/stream";
import { describe, expect, it } from "vitest";
import { boundedError, capLogs, MAX_FRAME_CHARS, parseFrame } from "../../src/stream/notifications.ts";
import { frameTexts, loadStreamFixture } from "../helpers/stream-fixtures.ts";

const fx = loadStreamFixture("jupiter-mentions");

describe("parseFrame on the recorded Helius session", () => {
  const frames = frameTexts(fx).map(parseFrame);

  it("reads the subscription answer, then every notification for that subscription", () => {
    const [first, ...rest] = frames;
    expect(first).toMatchObject({ kind: "subscribed", requestId: 1 });
    const subscription = first?.kind === "subscribed" ? first.subscription : -1;
    expect(rest.length).toBeGreaterThanOrEqual(12);
    for (const frame of rest) {
      expect(frame.kind).toBe("notification");
      if (frame.kind !== "notification") continue;
      expect(frame.subscription).toBe(subscription);
      expect(frame.slot).toBeGreaterThan(400_000_000);
      expect(frame.logs.length).toBeGreaterThan(0);
    }
  });

  it("keeps the on-chain error of failed notifications", () => {
    const failed = frames.find((f) => f.kind === "notification" && f.signature === fx.failed);
    expect(failed?.kind === "notification" && failed.err).toMatchObject({ InstructionError: expect.any(Array) as unknown });
    const ok = frames.find((f) => f.kind === "notification" && f.signature === fx.succeeded);
    expect(ok?.kind === "notification" && ok.err).toBeNull();
  });
});

describe("parseFrame never throws", () => {
  const notification = (signature: string, logs: unknown) =>
    JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: 7, result: { context: { slot: 1 }, value: { signature, err: null, logs } } } });

  it.each([
    ["not JSON", "{oops"],
    ["a number", "42"],
    ["a different notification", JSON.stringify({ jsonrpc: "2.0", method: "slotNotification", params: { subscription: 1, result: {} } })],
    ["a signature that isn't base58", notification("0OIl".repeat(20), [])],
    ["an oversized frame", "x".repeat(MAX_FRAME_CHARS + 1)],
  ])("ignores %s", (_, text) => {
    expect(parseFrame(text).kind).toBe("ignored");
  });

  it("reads a refused subscription and a notification without logs", () => {
    expect(parseFrame(JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Invalid params" } }))).toEqual({
      kind: "request-failed",
      requestId: 3,
      message: "Invalid params",
    });
    expect(parseFrame(notification(fx.succeeded, null))).toMatchObject({ kind: "notification", logs: [] });
  });
});

describe("capLogs", () => {
  it("keeps the contract's limits and cleans text Postgres rejects", () => {
    expect(capLogs(Array<string>(MAX_EVENT_LOGS + 5).fill("x"))).toHaveLength(MAX_EVENT_LOGS);
    const big = capLogs(Array<string>(10).fill("y".repeat(9000)));
    expect(big.reduce((n, l) => n + l.length, 0)).toBeLessThanOrEqual(MAX_EVENT_LOG_CHARS);
    expect(capLogs(["a\u0000b"])).toEqual(["a�b"]);
  });
});

describe("boundedError", () => {
  it("makes errors JSON-safe and replaces ones too large to keep", () => {
    expect(boundedError({ InstructionError: [3n, { Custom: 6001n }] })).toEqual({ InstructionError: [3, { Custom: 6001 }] });
    expect(boundedError(undefined)).toBeNull();
    expect(boundedError("AccountNotFound")).toBe("AccountNotFound");
    expect(boundedError({ huge: "x".repeat(5000) })).toEqual({ Unreadable: "error too large to keep" });
  });
});
