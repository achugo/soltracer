import { randomUUID } from "node:crypto";
import type { Override, SimulationResult } from "@soltracer/shared/simulation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { cleanJson } from "../text/clean.ts";
import { runs } from "../db/schema.ts";

export interface NewRun {
  wallet: string;
  engine: "local" | "rpc";
  input: string;
  overrides: Override[];
  /** u64 amounts are strings in the shared contract, so the result is plain JSON. */
  result: SimulationResult;
}

export interface StoredRun extends NewRun {
  id: string;
  createdAt: Date;
}

export interface RunStore {
  /** Persists a run and returns its random (v4) id. */
  create(run: NewRun): Promise<string>;
  /** The run if it exists and belongs to `wallet`; null otherwise. */
  get(id: string, wallet: string): Promise<StoredRun | null>;
}

export class PgRunStore implements RunStore {
  constructor(private readonly db: Db) {}

  async create(run: NewRun): Promise<string> {
    const id = randomUUID();
    // Program logs and decoded strings may hold text jsonb rejects (U+0000, lone surrogates).
    await this.db.insert(runs).values({ id, ...run, result: cleanJson(run.result) });
    return id;
  }

  async get(id: string, wallet: string): Promise<StoredRun | null> {
    // A malformed id is simply not found (the uuid column would otherwise raise an error).
    if (!z.uuid().safeParse(id).success) return null;
    const [row] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, id), eq(runs.wallet, wallet)));
    return row ? (row as StoredRun) : null;
  }
}
