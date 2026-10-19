import { z } from "zod";
import { MAX_LOG_LINE_CHARS } from "./trace.ts";
import { rpcErrorJsonSchema, simulationResultSchema, solBalanceSchema, tokenBalanceSchema } from "./simulation.ts";
import { pubkeySchema, signatureSchema } from "./solana.ts";

/** Most log lines, and characters across them, kept per stream event (the runtime's own log cap is 10 KB). */
export const MAX_EVENT_LOGS = 400;
export const MAX_EVENT_LOG_CHARS = 32 * 1024;
/** Most token balance changes listed per event. */
export const MAX_EVENT_TOKEN_DELTAS = 64;
/** Events in the snapshot a new feed connection gets, and per page of older events. */
export const STREAM_PAGE_SIZE = 50;

export const streamEventStatusSchema = z.enum([
  /** Seen (notification or gap fill), not yet hydrated with getTransaction. */
  "pending",
  "hydrated",
  /** getTransaction never found it after retries; shown with what the notification had. */
  "hydrate_failed",
]);

/** Opaque position for /stream/events?before= (older events). */
export const streamCursorSchema = z.string().min(1).max(256);

export const streamEventSchema = z
  .object({
  /** The allowlisted wallet the transaction mentions. */
  wallet: pubkeySchema,
  signature: signatureSchema,
  slot: z.number().int().min(0),
  /** RPC error JSON, null when the transaction succeeded. */
  onChainError: rpcErrorJsonSchema.nullable(),
  logs: z
    .array(z.string().max(MAX_LOG_LINE_CHARS))
    .max(MAX_EVENT_LOGS)
    .refine((l) => l.reduce((n, line) => n + line.length, 0) <= MAX_EVENT_LOG_CHARS, `At most ${MAX_EVENT_LOG_CHARS} characters of logs`),
  status: streamEventStatusSchema,
  /** Unix seconds; null until hydrated (and for blocks without a time). */
  blockTime: z.number().int().min(0).nullable(),
  /** The wallet's own SOL and token changes, once hydrated. */
  deltas: z
    .object({ sol: solBalanceSchema.nullable(), tokens: z.array(tokenBalanceSchema).max(MAX_EVENT_TOKEN_DELTAS) })
    .nullable(),
  /** The best-effort re-run of a failed transaction, once it has finished. */
  runId: z.uuidv4().nullable(),
  /** Set with runId: whether the re-run failed the same way as on-chain. */
  replayOutcomeMatches: z.boolean().nullable(),
  receivedAt: z.iso.datetime(),
})
  .superRefine((e, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if ((e.runId === null) !== (e.replayOutcomeMatches === null)) issue("replayOutcomeMatches", "Set exactly when runId is");
    // Only hydrated failures are re-run (the run needs the transaction's bytes).
    if (e.runId !== null && (e.status !== "hydrated" || e.onChainError === null)) issue("runId", "Only hydrated failures have a re-run");
    if (e.status !== "hydrated" && e.deltas !== null) issue("deltas", "Deltas come from hydration");
  });

export const streamConnectionStateSchema = z.enum(["connecting", "live", "reconnecting"]);

/** Messages from the engine's /stream socket, relayed to the browser as SSE. */
export const streamMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    events: z.array(streamEventSchema).max(STREAM_PAGE_SIZE),
    /** Pass to /stream/events?before= for older events; null when there are none. */
    cursor: streamCursorSchema.nullable(),
  }),
  /** A new event, or an update to one (hydrated, traced). */
  z.object({ type: z.literal("event"), event: streamEventSchema }),
  z.object({ type: z.literal("connection"), state: streamConnectionStateSchema, since: z.iso.datetime() }),
]);

export const streamPageSchema = z.object({
  events: z.array(streamEventSchema).max(STREAM_PAGE_SIZE),
  cursor: streamCursorSchema.nullable(),
});

export const runSourceSchema = z.enum(["sandbox", "stream"]);

/** A stored run, as /runs/:id returns it. */
export const storedRunSchema = z
  .object({
  id: z.uuidv4(),
  createdAt: z.iso.datetime(),
  /** The session wallet (sandbox) or the streamed wallet (stream) it belongs to. */
  wallet: pubkeySchema,
  source: runSourceSchema,
  result: simulationResultSchema,
  /** False for runs stored before traces existed; their trace and diffs are empty placeholders. */
  traceStored: z.boolean(),
})
  .superRefine((r, ctx) => {
    if (r.result.runId !== r.id) ctx.addIssue({ code: "custom", path: ["result", "runId"], message: "Must equal the run's id" });
    // Stream runs re-run landed transactions (labelled); sandbox runs never do.
    if ((r.source === "stream") !== (r.result.replay !== null)) {
      ctx.addIssue({ code: "custom", path: ["result", "replay"], message: "Set exactly for stream runs" });
    }
  });

export type StreamEventStatus = z.infer<typeof streamEventStatusSchema>;
export type StreamEvent = z.infer<typeof streamEventSchema>;
export type StreamConnectionState = z.infer<typeof streamConnectionStateSchema>;
export type StreamMessage = z.infer<typeof streamMessageSchema>;
export type StreamPage = z.infer<typeof streamPageSchema>;
export type RunSource = z.infer<typeof runSourceSchema>;
export type StoredRun = z.infer<typeof storedRunSchema>;
