import type { StreamEvent } from "@soltracer/shared/stream";
import { signature as toSignature } from "@solana/kit";
import { RpcError, type RpcSession } from "../rpc/client.ts";
import type { SimulatorLog } from "../sim/common.ts";
import { decodeTransactionInput } from "../tx/decode.ts";
import { walletDeltas, type BalanceMeta } from "./deltas.ts";
import { boundedError, capLogs } from "./notifications.ts";
import type { Hydration, StreamStore } from "./stream-store.ts";

/** A hydrated failed transaction, ready for a best-effort re-run. Handed off once per signature. */
export interface HydratedFailure {
  signature: string;
  slot: number;
  /** Base64 wire bytes, as landed (signed). */
  wire: string;
  /** RPC error JSON (JSON-safe, size-capped). */
  onChainError: unknown;
  /** Allowlisted wallets it mentions (the run is stored under the first). */
  wallets: string[];
}

export interface HydratorDeps {
  store: StreamStore;
  /** A fresh metered session per transaction, so its credits are logged on their own. */
  session: () => RpcSession;
  onEvent: (event: StreamEvent) => void;
  onFailure?: (failure: HydratedFailure) => void;
  log?: SimulatorLog;
  /** Waits between attempts; its length is the number of retries. Confirmed transactions can lag getTransaction briefly. */
  retryDelaysMs?: readonly number[];
}

export interface Hydrator {
  enqueue(wallet: string, signature: string): void;
  /** Resolves once nothing is queued, running or waiting to retry. */
  idle(): Promise<void>;
  stop(): void;
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
/** Recently hydrated signatures kept, so a wallet whose notification arrives late reuses the fetch. */
const RECENT_LIMIT = 256;

interface TransactionResult {
  slot: bigint | number;
  blockTime: bigint | number | null;
  transaction: readonly [string, string] | readonly string[];
  meta: (BalanceMeta & { err: unknown; logMessages?: readonly string[] | null; loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } | null }) | null;
}

/** What one getTransaction gives every wallet the transaction mentions. */
interface Fetched {
  wire: string;
  keys: string[];
  meta: BalanceMeta;
  base: Omit<Hydration, "deltas">;
}

/** Every account key in order: static keys, then lookup-table writable, then readonly (as meta indexes them). */
function accountKeysOf(wire: string, loaded: { writable: readonly string[]; readonly: readonly string[] } | null | undefined): string[] | null {
  const decoded = decodeTransactionInput(wire);
  if (!decoded.ok) return null;
  return [...decoded.tx.staticAccounts, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

/**
 * Fetches each seen transaction once with getTransaction (10 credits) and fills in its block time,
 * balance changes, logs and error for every wallet it mentions. Work is sequential, so a burst of
 * notifications queues here instead of filling the RPC client's queue. Nothing here can throw out:
 * a failure leaves rows pending for the next sweep.
 */
export function createHydrator({ store, session, onEvent, onFailure, log, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS }: HydratorDeps): Hydrator {
  /** Signature -> wallets, ready to fetch, in arrival order. */
  const queue = new Map<string, Set<string>>();
  /** Signatures waiting for a retry; wallets arriving meanwhile join the same set. */
  const waiting = new Map<string, { wallets: Set<string>; timer: ReturnType<typeof setTimeout> }>();
  /** The transaction being fetched; wallets arriving meanwhile join it. */
  let inFlight: { signature: string; wallets: Set<string> } | null = null;
  const attempts = new Map<string, number>();
  const recent = new Map<string, Fetched>();
  let running = false;
  let stopped = false;
  let idleWaiters: (() => void)[] = [];

  const isIdle = () => !running && queue.size === 0 && waiting.size === 0;
  function settleIdle() {
    if (!isIdle()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  }

  /** Callbacks are the caller's code: one that throws must not stop hydration. */
  function emit(event: StreamEvent | null) {
    if (!event || stopped) return;
    try {
      onEvent(event);
    } catch {
      log?.info({ signature: event.signature, why: "event handler threw" }, "stream event not delivered");
    }
  }

  function enqueue(wallet: string, signature: string) {
    if (stopped) return;
    const joined = inFlight?.signature === signature ? inFlight.wallets : waiting.get(signature)?.wallets;
    if (joined) {
      joined.add(wallet);
      return;
    }
    const wallets = queue.get(signature) ?? new Set<string>();
    wallets.add(wallet);
    queue.set(signature, wallets);
    void pump();
  }

  async function pump() {
    if (running || stopped) return;
    running = true;
    try {
      for (let next = queue.entries().next(); !next.done && !stopped; next = queue.entries().next()) {
        const [signature, wallets] = next.value;
        queue.delete(signature);
        inFlight = { signature, wallets };
        try {
          await hydrate(signature, wallets);
        } catch {
          // A store or decoding failure: the rows stay pending and the startup sweep retries them.
          log?.info({ signature, why: "hydrate threw" }, "stream hydration left pending");
        } finally {
          inFlight = null;
        }
      }
    } finally {
      running = false;
      settleIdle();
    }
  }

  /** Runs `each` for every wallet in the live set, including ones that join while it runs. */
  async function forEachWallet(wallets: Set<string>, each: (wallet: string) => Promise<void>): Promise<string[]> {
    const done: string[] = [];
    for (let todo = [...wallets]; todo.length > 0 && !stopped; todo = [...wallets].filter((w) => !done.includes(w))) {
      for (const wallet of todo) {
        done.push(wallet);
        await each(wallet);
      }
    }
    return done;
  }

  async function retryOrGiveUp(signature: string, wallets: Set<string>, why: string) {
    if (stopped) return;
    const attempt = attempts.get(signature) ?? 0;
    const delay = retryDelaysMs[attempt];
    if (delay === undefined) {
      attempts.delete(signature);
      log?.info({ signature, why }, "stream hydration gave up");
      await forEachWallet(wallets, async (w) => emit(await store.hydrateFailed(w, signature)));
      return;
    }
    attempts.set(signature, attempt + 1);
    const timer = setTimeout(() => {
      waiting.delete(signature);
      if (!stopped) {
        queue.set(signature, wallets);
        void pump();
      }
      settleIdle();
    }, delay);
    waiting.set(signature, { wallets, timer });
  }

  async function fetchTransaction(signature: string): Promise<{ fetched: Fetched } | { why: string }> {
    const s = session();
    let tx: TransactionResult | null;
    try {
      tx = (await s.rpc
        .getTransaction(toSignature(signature), { encoding: "base64", maxSupportedTransactionVersion: 1, commitment: "confirmed" })
        .send()) as TransactionResult | null;
    } catch (err) {
      // Never log the error itself: an RPC error's details are redacted, anything else might not be.
      return { why: err instanceof RpcError ? err.code : "request failed" };
    }
    log?.info({ signature, credits: s.credits() }, "stream transaction fetched");
    const wire = tx?.transaction[0];
    const keys = wire && tx?.meta ? accountKeysOf(wire, tx.meta.loadedAddresses) : null;
    if (!tx?.meta || !wire || !keys) return { why: tx ? "unreadable transaction" : "not found yet" };
    return {
      fetched: {
        wire,
        keys,
        meta: tx.meta,
        base: {
          slot: Number(tx.slot),
          blockTime: tx.blockTime === null ? null : Number(tx.blockTime),
          onChainError: boundedError(tx.meta.err ?? null),
          logs: capLogs(tx.meta.logMessages ?? []),
        },
      },
    };
  }

  async function hydrate(signature: string, wallets: Set<string>) {
    const cached = recent.get(signature);
    let fetched: Fetched;
    if (cached) {
      fetched = cached;
    } else {
      const outcome = await fetchTransaction(signature);
      if ("why" in outcome) return retryOrGiveUp(signature, wallets, outcome.why);
      fetched = outcome.fetched;
      attempts.delete(signature);
    }
    const done = await forEachWallet(wallets, async (wallet) => {
      emit(await store.hydrated(wallet, signature, { ...fetched.base, deltas: walletDeltas(wallet, fetched.keys, fetched.meta) }));
    });
    // Cached only once every row is written: if a write throws, the next attempt fetches afresh and hands the failure off.
    if (!cached) {
      recent.set(signature, fetched);
      for (const old of recent.keys()) {
        if (recent.size <= RECENT_LIMIT) break;
        recent.delete(old);
      }
    }
    // The failure is handed off once, when first fetched; a late wallet's row picks up the run itself.
    if (!cached && fetched.base.onChainError !== null && !stopped && onFailure) {
      try {
        onFailure({ signature, slot: fetched.base.slot, wire: fetched.wire, onChainError: fetched.base.onChainError, wallets: done });
      } catch {
        log?.info({ signature, why: "failure handler threw" }, "stream failure not handed off");
      }
    }
  }

  return {
    enqueue,
    idle: () => (isIdle() ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve))),
    stop() {
      stopped = true;
      queue.clear();
      for (const { timer } of waiting.values()) clearTimeout(timer);
      waiting.clear();
      settleIdle();
    },
  };
}
