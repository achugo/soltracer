import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
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

/** Account data at least this large (program binaries) is stored once, gzipped, outside the JSON. */
export const BLOB_MIN_BASE64 = 64 * 1024;
const BLOB_PREFIX = "@blob:";

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

/** Replaces large base64 strings with "@blob:<sha256>" and writes each once to `dir` as <sha256>.b64.gz. */
export function externalizeBlobs(value: unknown, dir: string): unknown {
  return mapStrings(value, (s) => {
    if (s.length < BLOB_MIN_BASE64 || !/^[A-Za-z0-9+/]+=*$/.test(s)) return s;
    const hash = createHash("sha256").update(s).digest("hex");
    const file = `${dir}/${hash}.b64.gz`;
    if (!existsSync(file)) writeFileSync(file, gzipSync(s, { level: 9 }));
    return `${BLOB_PREFIX}${hash}`;
  });
}

/** Inverse of externalizeBlobs: inflates every "@blob:<sha256>" from `dir`, verifying the content hash. */
export function resolveBlobs(value: unknown, dir: string): unknown {
  return mapStrings(value, (s) => {
    if (!s.startsWith(BLOB_PREFIX)) return s;
    const hash = s.slice(BLOB_PREFIX.length);
    // Only a hex digest may name a file, so a reference can't point outside `dir`.
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Bad blob reference: ${hash.slice(0, 80)}`);
    const data = gunzipSync(readFileSync(`${dir}/${hash}.b64.gz`)).toString("utf8");
    if (createHash("sha256").update(data).digest("hex") !== hash) throw new Error(`Blob ${hash} is corrupt`);
    return data;
  });
}
