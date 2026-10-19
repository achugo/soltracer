import { bigint, boolean, index, jsonb, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";

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

/** Mint decimals never change, so they are cached forever. */
export const mintCache = pgTable("mint_cache", {
  mint: text("mint").primaryKey(),
  decimals: smallint("decimals").notNull(),
  program: text("program", { enum: ["token", "token-2022"] }).notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/** Lookup tables only grow; a cached copy serves any index below its length. */
export const lookupTableCache = pgTable("lookup_table_cache", {
  address: text("address").primaryKey(),
  addresses: text("addresses").array().notNull(),
  slot: bigint("slot", { mode: "bigint" }),
  fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/** Anchor IDL error tables per program; `found = false` records that a program has no IDL. */
export const idlCache = pgTable("idl_cache", {
  program: text("program").primaryKey(),
  found: boolean("found").notNull(),
  errors: jsonb("errors").$type<[number, string, string][]>(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
