import { randomUUID } from "node:crypto";
import type { Override, SimulationResult } from "@soltracer/shared/simulation";
import { storedRunSchema, type RunSource, type StoredRun } from "@soltracer/shared/stream";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { cleanJson } from "../text/clean.ts";
import { runs } from "../db/schema.ts";

export interface NewRun {
  wallet: string;
  engine: "local" | "rpc";
  /** Defaults to "sandbox". */
  source?: RunSource;
  input: string;
  overrides: Override[];
  /** u64 amounts are strings in the shared contract, so the result is plain JSON. */
  result: SimulationResult;
}

export interface RunStore {
  /** Persists a run and returns its random (v4) id. */
  create(run: NewRun): Promise<string>;
  /**
   * The run, for any allowlisted session (the route has already checked the session); null if there
   * is no such run. Throws UnreadableRunError when the stored row doesn't fit the contract.
   */
  get(id: string): Promise<StoredRun | null>;
}

export class UnreadableRunError extends Error {
  override name = "UnreadableRunError";
}

/**
 * Rows from earlier phases lack fields added since: no trace or diffs before Phase 4, no replay label
 * before Phase 5. Fill them in as empty placeholders and say whether a trace was stored.
 */
export function upgradeStoredResult(stored: unknown, id: string): { result: unknown; traceStored: boolean } {
  if (typeof stored !== "object" || stored === null) return { result: stored, traceStored: false };
  const result = stored as Record<string, unknown>;
  const traceStored = "trace" in result;
  return {
    result: {
      ...result,
      trace: result.trace ?? { nodes: [], failingNodeId: null, complete: false },
      accountDiffs: result.accountDiffs ?? [],
      replay: result.replay ?? null,
      // The id is assigned after the result is built, so the stored copy has runId null.
      runId: id,
    },
    traceStored,
  };
}

export class PgRunStore implements RunStore {
  constructor(private readonly db: Db) {}

  async create(run: NewRun): Promise<string> {
    const id = randomUUID();
    // Program logs and decoded strings may hold text jsonb rejects (U+0000, lone surrogates).
    await this.db.insert(runs).values({ id, ...run, source: run.source ?? "sandbox", result: cleanJson(run.result) });
    return id;
  }

  async get(id: string): Promise<StoredRun | null> {
    // A malformed id is simply not found (the uuid column would otherwise raise an error).
    if (!z.uuid().safeParse(id).success) return null;
    const [row] = await this.db.select().from(runs).where(eq(runs.id, id));
    if (!row) return null;
    const { result, traceStored } = upgradeStoredResult(row.result, row.id);
    const parsed = storedRunSchema.safeParse({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      wallet: row.wallet,
      source: row.source,
      result,
      traceStored,
    });
    if (!parsed.success) throw new UnreadableRunError(`Stored run ${row.id} doesn't match the current contract`);
    return parsed.data;
  }
}
