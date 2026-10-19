import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { authNonces } from "../db/schema.ts";

export type ConsumeResult =
  | { status: "ok"; issuedAt: Date }
  | { status: "unknown" }
  | { status: "used" }
  | { status: "expired" };

export interface NonceStore {
  create(nonce: string, issuedAt: Date, expiresAt: Date): Promise<void>;
  /** Atomically marks the nonce used if it is unused and unexpired at `now`. */
  consume(nonce: string, now: Date): Promise<ConsumeResult>;
}

export class PgNonceStore implements NonceStore {
  constructor(private readonly db: Db) {}

  async create(nonce: string, issuedAt: Date, expiresAt: Date): Promise<void> {
    await this.db.insert(authNonces).values({ nonce, issuedAt, expiresAt });
  }

  async consume(nonce: string, now: Date): Promise<ConsumeResult> {
    const [spent] = await this.db
      .update(authNonces)
      .set({ usedAt: now })
      .where(and(eq(authNonces.nonce, nonce), isNull(authNonces.usedAt), gt(authNonces.expiresAt, now)))
      .returning({ issuedAt: authNonces.issuedAt });
    if (spent) return { status: "ok", issuedAt: spent.issuedAt };

    const [row] = await this.db
      .select({ usedAt: authNonces.usedAt })
      .from(authNonces)
      .where(eq(authNonces.nonce, nonce));
    if (!row) return { status: "unknown" };
    return row.usedAt ? { status: "used" } : { status: "expired" };
  }

  /** Deletes nonces that expired before `cutoff`. Returns how many were removed. */
  async pruneExpired(cutoff: Date): Promise<number> {
    const removed = await this.db
      .delete(authNonces)
      .where(lt(authNonces.expiresAt, cutoff))
      .returning({ nonce: authNonces.nonce });
    return removed.length;
  }
}
