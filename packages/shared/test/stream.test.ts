import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { simulationResultSchema, type SimulationResult } from "../src/simulation.ts";
import {
  MAX_EVENT_LOGS,
  STREAM_PAGE_SIZE,
  storedRunSchema,
  streamEventSchema,
  streamMessageSchema,
  streamPageSchema,
  type StreamEvent,
} from "../src/stream.ts";

const key = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));
const sig = (fill: number) => bs58.encode(new Uint8Array(64).fill(fill));

const event: StreamEvent = {
  wallet: key(1),
  signature: sig(2),
  slot: 457_205_151,
  onChainError: { InstructionError: [3, { Custom: 6001 }] },
  logs: ["Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]"],
  status: "hydrated",
  blockTime: 1_792_060_318,
  deltas: {
    sol: { address: key(1), pre: "1000000000", post: "999995000", delta: "-5000" },
    tokens: [],
  },
  runId: "4b1f3a5e-9c2d-4e8f-a1b2-3c4d5e6f7a8b",
  replayOutcomeMatches: true,
  receivedAt: "2026-10-15T12:31:00.000Z",
};

describe("streamEventSchema", () => {
  it("accepts a hydrated, traced failure", () => {
    expect(streamEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a pending event before hydration", () => {
    const pending = { ...event, status: "pending", blockTime: null, deltas: null, runId: null, replayOutcomeMatches: null, onChainError: null };
    expect(streamEventSchema.safeParse(pending).success).toBe(true);
  });

  it.each([
    ["a malformed signature", { signature: "abc" }],
    ["an unknown status", { status: "done" }],
    ["a bigint error index", { onChainError: { InstructionError: [3n, "x"] } }],
    ["error JSON past the size cap", { onChainError: { x: "y".repeat(3000) } }],
    ["more log text than the cap", { logs: Array<string>(5).fill("x".repeat(9000)) }],
    ["a negative block time", { blockTime: -1 }],
    ["a run id without its outcome", { replayOutcomeMatches: null }],
    ["an outcome without a run id", { runId: null }],
    ["a re-run of a transaction that succeeded", { onChainError: null }],
    ["a re-run before hydration", { status: "pending", deltas: null }],
    ["deltas before hydration", { status: "hydrate_failed", runId: null, replayOutcomeMatches: null }],
    ["too many log lines", { logs: Array<string>(MAX_EVENT_LOGS + 1).fill("x") }],
    ["a run id that isn't a v4 uuid", { runId: "not-a-uuid" }],
    ["a local time without a zone", { receivedAt: "2026-10-15 12:31" }],
  ])("rejects %s", (_, patch) => {
    expect(streamEventSchema.safeParse({ ...event, ...patch }).success).toBe(false);
  });
});

describe("streamMessageSchema", () => {
  it("accepts snapshot, event and connection messages", () => {
    for (const message of [
      { type: "snapshot", events: [event], cursor: "c1" },
      { type: "snapshot", events: [], cursor: null },
      { type: "event", event },
      { type: "connection", state: "reconnecting", since: "2026-10-15T12:31:00.000Z" },
    ]) {
      expect(streamMessageSchema.safeParse(message).success, JSON.stringify(message).slice(0, 40)).toBe(true);
    }
  });

  it("rejects unknown types and oversized snapshots", () => {
    expect(streamMessageSchema.safeParse({ type: "hello" }).success).toBe(false);
    expect(streamMessageSchema.safeParse({ type: "snapshot", events: Array(STREAM_PAGE_SIZE + 1).fill(event), cursor: null }).success).toBe(false);
    expect(streamPageSchema.safeParse({ events: Array(STREAM_PAGE_SIZE + 1).fill(event), cursor: null }).success).toBe(false);
  });
});

const result: SimulationResult = {
  ok: true,
  encoding: "base64",
  version: 0,
  signed: true,
  accounts: [{ address: key(1), writable: true, signer: true, source: { kind: "static" } }],
  computeBudget: { limit: 200_000, limitSource: "default", defaultLimit: 200_000, priceMicroLamports: "0", priorityFeeLamports: "0", loadedAccountsDataSizeLimit: null },
  unitsConsumed: 1000,
  status: { success: true },
  fee: { baseLamports: "5000", priorityLamports: "0", totalLamports: "5000" },
  balances: { sol: [], tokens: [] },
  logs: [],
  slot: 1,
  credits: 6,
  engine: "local",
  fallbackReason: null,
  perInstruction: [],
  overrides: [],
  trace: { nodes: [], failingNodeId: null, complete: true },
  accountDiffs: [],
  replay: {
    signature: sig(2),
    slot: 457_205_151,
    onChainError: { InstructionError: [3, { Custom: 6001 }] },
    onChainTxError: { instructionIndex: 3, programId: key(3), failingProgramId: key(3), code: 6001, name: "SlippageToleranceExceeded", message: "Slippage tolerance exceeded", source: "idl", raw: null },
    accuracy: "best-effort",
    outcomeMatches: false,
  },
  runId: "4b1f3a5e-9c2d-4e8f-a1b2-3c4d5e6f7a8b",
};

describe("replay label and stored runs", () => {
  it("a re-run of a landed transaction carries its best-effort label", () => {
    expect(simulationResultSchema.parse(result).replay?.accuracy).toBe("best-effort");
    expect(simulationResultSchema.safeParse({ ...result, replay: { ...result.replay, accuracy: "exact" } }).success).toBe(false);
  });

  it("a replay of a transaction that succeeded on-chain matches only if it succeeds", () => {
    const replay = { ...result.replay, onChainError: null, onChainTxError: null };
    expect(simulationResultSchema.safeParse({ ...result, replay: { ...replay, outcomeMatches: true } }).success).toBe(true);
    expect(simulationResultSchema.safeParse({ ...result, replay: { ...replay, outcomeMatches: false } }).success).toBe(false);
    expect(simulationResultSchema.safeParse({ ...result, replay: { ...result.replay, onChainTxError: null } }).success).toBe(false);
  });

  it("a stored run says where it came from and whether its trace was stored", () => {
    const run = { id: "4b1f3a5e-9c2d-4e8f-a1b2-3c4d5e6f7a8b", createdAt: "2026-10-15T12:31:00.000Z", wallet: key(1), source: "stream", result, traceStored: true };
    expect(storedRunSchema.safeParse(run).success).toBe(true);
    expect(storedRunSchema.safeParse({ ...run, source: "elsewhere" }).success).toBe(false);
    expect(storedRunSchema.safeParse({ ...run, source: "sandbox" }).success).toBe(false); // sandbox runs carry no replay
    expect(storedRunSchema.safeParse({ ...run, id: "5b1f3a5e-9c2d-4e8f-a1b2-3c4d5e6f7a8b" }).success).toBe(false);
  });
});
