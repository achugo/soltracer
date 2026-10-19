import { STREAM_PAGE_SIZE, streamEventSchema, type StreamEvent, type StreamPage } from "@soltracer/shared/stream";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { streamEvents } from "../db/schema.ts";
import { jsonSafe } from "../decode/program-error.ts";
import { cleanJson } from "../text/clean.ts";

/** What a notification or gap fill knows about a transaction before hydration. */
export interface SeenTransaction {
  wallet: string;
  signature: string;
  slot: number;
  /** RPC error JSON (BigInts allowed; stored as JSON numbers or strings). */
  onChainError: unknown;
  logs: readonly string[];
}

export interface Hydration {
  slot: number;
  blockTime: number | null;
  onChainError: unknown;
  logs: readonly string[];
  deltas: StreamEvent["deltas"];
}

export interface StreamStore {
  /** Stores a transaction the first time it is seen for a wallet; null when it was already stored. */
  insertIfNew(seen: SeenTransaction): Promise<StreamEvent | null>;
  hydrated(wallet: string, signature: string, hydration: Hydration): Promise<StreamEvent | null>;
  hydrateFailed(wallet: string, signature: string): Promise<StreamEvent | null>;
  /** Links a re-run to every wallet's row for the signature. */
  attachRun(signature: string, runId: string, outcomeMatches: boolean): Promise<StreamEvent[]>;
  /** Newest first (chain order), up to STREAM_PAGE_SIZE, strictly older than `before`. */
  page(before: string | null): Promise<StreamPage>;
  /** The wallet's newest stored transaction: where gap fill starts. */
  latest(wallet: string): Promise<{ signature: string; slot: number } | null>;
  /** Transactions still waiting for hydration, oldest first. */
  pending(limit: number): Promise<{ wallet: string; signature: string }[]>;
}

type Row = typeof streamEvents.$inferSelect;

/** Rows are written by this store, but jsonb is only typed at compile time: a row that fails the contract is skipped. */
function toEvent(row: Row): StreamEvent | null {
  const parsed = streamEventSchema.safeParse({
    wallet: row.wallet,
    signature: row.signature,
    slot: row.slot,
    onChainError: row.onChainError ?? null,
    logs: row.logs,
    status: row.status,
    blockTime: row.blockTime,
    deltas: row.deltas ?? null,
    runId: row.runId,
    replayOutcomeMatches: row.replayOutcomeMatches,
    receivedAt: row.receivedAt.toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

const toJson = (value: unknown) => cleanJson(jsonSafe(value));

/** Cursor: "<slot>.<signature>.<wallet>" of the last event on a page (base58 has no dots). */
const CURSOR = /^(\d{1,16})\.([1-9A-HJ-NP-Za-km-z]{32,88})\.([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const cursorOf = (r: { slot: number; signature: string; wallet: string }) => `${r.slot}.${r.signature}.${r.wallet}`;

export class InvalidCursorError extends Error {
  override name = "InvalidCursorError";
}

export class PgStreamStore implements StreamStore {
  constructor(private readonly db: Db) {}

  async insertIfNew(seen: SeenTransaction): Promise<StreamEvent | null> {
    const [row] = await this.db
      .insert(streamEvents)
      .values({
        wallet: seen.wallet,
        signature: seen.signature,
        slot: seen.slot,
        onChainError: toJson(seen.onChainError),
        logs: toJson(seen.logs) as string[],
        status: "pending",
      })
      .onConflictDoNothing()
      .returning();
    return row ? toEvent(row) : null;
  }

  async hydrated(wallet: string, signature: string, h: Hydration): Promise<StreamEvent | null> {
    const [row] = await this.db
      .update(streamEvents)
      .set({
        status: "hydrated",
        slot: h.slot,
        blockTime: h.blockTime,
        onChainError: toJson(h.onChainError),
        logs: toJson(h.logs) as string[],
        deltas: toJson(h.deltas),
        // Another wallet's row for the same signature may already have its re-run: share it.
        runId: sql`coalesce(${streamEvents.runId}, (select s.run_id from stream_events s where s.signature = ${signature} and s.run_id is not null limit 1))`,
        replayOutcomeMatches: sql`coalesce(${streamEvents.replayOutcomeMatches}, (select s.replay_outcome_matches from stream_events s where s.signature = ${signature} and s.run_id is not null limit 1))`,
      })
      .where(and(eq(streamEvents.wallet, wallet), eq(streamEvents.signature, signature)))
      .returning();
    return row ? toEvent(row) : null;
  }

  async hydrateFailed(wallet: string, signature: string): Promise<StreamEvent | null> {
    const [row] = await this.db
      .update(streamEvents)
      .set({ status: "hydrate_failed" })
      .where(and(eq(streamEvents.wallet, wallet), eq(streamEvents.signature, signature), eq(streamEvents.status, "pending")))
      .returning();
    return row ? toEvent(row) : null;
  }

  async attachRun(signature: string, runId: string, outcomeMatches: boolean): Promise<StreamEvent[]> {
    const rows = await this.db
      .update(streamEvents)
      .set({ runId, replayOutcomeMatches: outcomeMatches })
      // Only hydrated failures are re-run (the contract's rule); other rows are left alone.
      .where(and(eq(streamEvents.signature, signature), eq(streamEvents.status, "hydrated"), isNotNull(streamEvents.onChainError)))
      .returning();
    return rows.flatMap((r) => toEvent(r) ?? []);
  }

  async page(before: string | null): Promise<StreamPage> {
    let where;
    if (before !== null) {
      const m = CURSOR.exec(before);
      if (!m) throw new InvalidCursorError("Invalid cursor");
      const [, slot, signature, wallet] = m;
      where = sql`(${streamEvents.slot}, ${streamEvents.signature}, ${streamEvents.wallet}) < (${Number(slot)}, ${signature}, ${wallet})`;
    }
    const rows = await this.db
      .select()
      .from(streamEvents)
      .where(where)
      .orderBy(desc(streamEvents.slot), desc(streamEvents.signature), desc(streamEvents.wallet))
      .limit(STREAM_PAGE_SIZE + 1);
    const events = rows.slice(0, STREAM_PAGE_SIZE).flatMap((r) => toEvent(r) ?? []);
    // The cursor comes from the raw row, so an unreadable row at the boundary can't end paging.
    const last = rows[STREAM_PAGE_SIZE - 1];
    return { events, cursor: rows.length > STREAM_PAGE_SIZE && last ? cursorOf(last) : null };
  }

  async latest(wallet: string): Promise<{ signature: string; slot: number } | null> {
    const [row] = await this.db
      .select({ signature: streamEvents.signature, slot: streamEvents.slot })
      .from(streamEvents)
      .where(eq(streamEvents.wallet, wallet))
      .orderBy(desc(streamEvents.slot), desc(streamEvents.signature))
      .limit(1);
    return row ?? null;
  }

  async pending(limit: number): Promise<{ wallet: string; signature: string }[]> {
    return this.db
      .select({ wallet: streamEvents.wallet, signature: streamEvents.signature })
      .from(streamEvents)
      .where(eq(streamEvents.status, "pending"))
      .orderBy(streamEvents.slot, streamEvents.signature)
      .limit(limit);
  }
}
