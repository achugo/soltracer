import { MAX_EVENT_LOG_CHARS, MAX_EVENT_LOGS } from "@soltracer/shared/stream";
import { MAX_RPC_ERROR_CHARS } from "@soltracer/shared/simulation";
import { MAX_LOG_LINE_CHARS } from "@soltracer/shared/trace";
import { z } from "zod";
import { jsonSafe } from "../decode/program-error.ts";
import { cleanJson, cleanText } from "../text/clean.ts";

/** Largest socket frame read; a logsNotification is a few KB (the runtime caps logs at 10 KB). */
export const MAX_FRAME_CHARS = 256 * 1024;

export type Frame =
  /** Answer to our logsSubscribe request `requestId`. */
  | { kind: "subscribed"; requestId: number; subscription: number }
  | { kind: "request-failed"; requestId: number; message: string }
  | { kind: "notification"; subscription: number; slot: number; signature: string; err: unknown; logs: string[] }
  /** Anything else (unsubscribe answers, other notifications, garbage): ignored. */
  | { kind: "ignored"; reason: string };

const id = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const subscribedSchema = z.object({ jsonrpc: z.literal("2.0"), id, result: id });
const failedSchema = z.object({ jsonrpc: z.literal("2.0"), id, error: z.object({ message: z.string() }) });
const notificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("logsNotification"),
  params: z.object({
    subscription: id,
    result: z.object({
      context: z.object({ slot: id }),
      value: z.object({
        signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
        err: z.unknown(),
        logs: z.array(z.string()).nullable(),
      }),
    }),
  }),
});

/** Parses one frame from the Helius socket. Never throws: unexpected input is "ignored", with why. */
export function parseFrame(text: string): Frame {
  if (text.length > MAX_FRAME_CHARS) return { kind: "ignored", reason: "frame too large" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "ignored", reason: "not JSON" };
  }
  const note = notificationSchema.safeParse(json);
  if (note.success) {
    const { subscription, result } = note.data.params;
    return {
      kind: "notification",
      subscription,
      slot: result.context.slot,
      signature: result.value.signature,
      err: boundedError(result.value.err ?? null),
      logs: capLogs(result.value.logs ?? []),
    };
  }
  const subscribed = subscribedSchema.safeParse(json);
  if (subscribed.success) return { kind: "subscribed", requestId: subscribed.data.id, subscription: subscribed.data.result };
  const failed = failedSchema.safeParse(json);
  if (failed.success) return { kind: "request-failed", requestId: failed.data.id, message: failed.data.error.message.slice(0, 200) };
  return { kind: "ignored", reason: "not a logs notification or subscription answer" };
}

/** Logs as the stream contract allows: clean text, capped per line, in count and in total length. */
export function capLogs(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (kept.length >= MAX_EVENT_LOGS) break;
    const text = cleanText(line.slice(0, MAX_LOG_LINE_CHARS));
    if (chars + text.length > MAX_EVENT_LOG_CHARS) break;
    kept.push(text);
    chars += text.length;
  }
  return kept;
}

/**
 * A transaction error as the stream contract stores it: JSON-safe (no BigInt), clean text, and no
 * larger than MAX_RPC_ERROR_CHARS. Real errors are tiny; anything larger is replaced, not dropped.
 */
export function boundedError(err: unknown): unknown {
  if (err === null || err === undefined) return null;
  const safe = cleanJson(jsonSafe(err));
  const text = JSON.stringify(safe);
  return text !== undefined && text.length <= MAX_RPC_ERROR_CHARS ? safe : { Unreadable: "error too large to keep" };
}
