import { bigint, boolean, index, jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

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

/**
 * Anchor IDLs per program: the error table, and the normalized IDL used to decode instructions and
 * accounts (null when the IDL is too large or not in a format we decode). `found = false` records
 * that a program has no IDL.
 */
export const idlCache = pgTable("idl_cache", {
  program: text("program").primaryKey(),
  found: boolean("found").notNull(),
  errors: jsonb("errors").$type<[number, string, string][]>(),
  idl: jsonb("idl"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/** Every run: sandbox runs and the streamer's re-runs of failed transactions. Ids are random UUIDs. */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    /** The session wallet (sandbox) or the streamed wallet (stream). Any allowlisted session may read it. */
    wallet: text("wallet").notNull(),
    source: text("source", { enum: ["sandbox", "stream"] }).notNull().default("sandbox"),
    engine: text("engine", { enum: ["local", "rpc"] }).notNull(),
    input: text("input").notNull(),
    overrides: jsonb("overrides").notNull(),
    result: jsonb("result").notNull(),
  },
  (t) => [index("runs_wallet_created_at_idx").on(t.wallet, t.createdAt)],
);

/**
 * Transactions that mention an allowlisted wallet, from logsSubscribe or gap fill. One row per wallet
 * it mentions. Hydrated with getTransaction; failures get a best-effort re-run (run_id).
 */
export const streamEvents = pgTable(
  "stream_events",
  {
    wallet: text("wallet").notNull(),
    signature: text("signature").notNull(),
    slot: bigint("slot", { mode: "number" }).notNull(),
    onChainError: jsonb("on_chain_error"),
    logs: jsonb("logs").$type<string[]>().notNull(),
    status: text("status", { enum: ["pending", "hydrated", "hydrate_failed"] }).notNull(),
    blockTime: bigint("block_time", { mode: "number" }),
    deltas: jsonb("deltas"),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    replayOutcomeMatches: boolean("replay_outcome_matches"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.wallet, t.signature] }),
    // The feed reads newest first by chain order; this is its exact sort, so pages are index scans.
    index("stream_events_page_idx").on(t.slot.desc(), t.signature.desc(), t.wallet.desc()),
    index("stream_events_status_idx").on(t.status),
  ],
);
