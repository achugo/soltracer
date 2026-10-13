import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Single-use sign-in nonces. A nonce is spent when used_at is set. */
export const authNonces = pgTable(
  "auth_nonces",
  {
    nonce: text("nonce").primaryKey(),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [index("auth_nonces_expires_at_idx").on(t.expiresAt)],
);
