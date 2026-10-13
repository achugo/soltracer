import type { ConsumeResult, NonceStore } from "../../src/auth/nonce-store.ts";

/** In-memory NonceStore with the same semantics as PgNonceStore. */
export class MemoryNonceStore implements NonceStore {
  private readonly rows = new Map<string, { issuedAt: Date; expiresAt: Date; usedAt: Date | null }>();

  async create(nonce: string, issuedAt: Date, expiresAt: Date): Promise<void> {
    this.rows.set(nonce, { issuedAt, expiresAt, usedAt: null });
  }

  async consume(nonce: string, now: Date): Promise<ConsumeResult> {
    const row = this.rows.get(nonce);
    if (!row) return { status: "unknown" };
    if (row.usedAt) return { status: "used" };
    if (row.expiresAt <= now) return { status: "expired" };
    row.usedAt = now;
    return { status: "ok", issuedAt: row.issuedAt };
  }
}
