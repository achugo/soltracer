import type { RpcTransport } from "@solana/kit";
import { isJsonRpcPayload } from "@solana/kit";
import type { RpcCallRecord } from "./client.ts";

/** Parses recorded JSON the way kit's transport does: every integer literal becomes a bigint. */
export function parseRecordedJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && context?.source !== undefined && /^-?\d+$/.test(context.source)
      ? BigInt(context.source)
      : value,
  );
}

/** Stable key for a call: method plus params with sorted keys; numbers and bigints compare equal. */
export function callKey(method: string, params: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (typeof v === "bigint") return `#${v.toString()}`;
    if (typeof v === "number" && Number.isInteger(v)) return `#${v}`;
    if (Array.isArray(v)) return v.map(canonical);
    if (typeof v === "object" && v !== null) {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return `${method} ${JSON.stringify(canonical(params))}`;
}

export class ReplayMissError extends Error {
  override name = "ReplayMissError";
}

/**
 * Serves recorded RPC exchanges instead of calling Helius. Identical calls are served in recorded
 * order. A call that was never recorded throws, so tests fail loudly when the call pattern changes.
 */
export function createReplayTransport(records: readonly RpcCallRecord[]): RpcTransport & { unused(): number } {
  const queues = new Map<string, unknown[]>();
  for (const r of records) {
    const key = callKey(r.method, r.params);
    queues.set(key, [...(queues.get(key) ?? []), r.response]);
  }
  const transport = (async ({ payload }: { payload: unknown }) => {
    if (!isJsonRpcPayload(payload)) throw new ReplayMissError("Not a JSON-RPC payload");
    const key = callKey(payload.method, payload.params);
    const response = queues.get(key)?.shift();
    if (response === undefined) throw new ReplayMissError(`No recorded response for ${key.slice(0, 300)}`);
    const id = (payload as { id?: unknown }).id;
    return typeof response === "object" && response !== null ? { ...response, id } : response;
  }) as RpcTransport;
  return Object.assign(transport, { unused: () => [...queues.values()].reduce((n, q) => n + q.length, 0) });
}
