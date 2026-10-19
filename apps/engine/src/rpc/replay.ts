import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync, inflateSync } from "node:zlib";
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

export class MissingBlobError extends Error {
  override name = "MissingBlobError";
  constructor(readonly hash: string) {
    super(`Fixture blob ${hash} isn't present (third-party material is kept in a local cache, not committed)`);
  }
}

const blobPath = (dirs: readonly string[], hash: string) => dirs.map((d) => `${d}/${hash}.b64.gz`).find((f) => existsSync(f));

/**
 * Inverse of externalizeBlobs: inflates every "@blob:<sha256>" from the first of `dirs` that has it,
 * verifying the content hash. Throws MissingBlobError when none has it.
 */
export function resolveBlobs(value: unknown, dirs: string | readonly string[]): unknown {
  const searched = typeof dirs === "string" ? [dirs] : dirs;
  return mapStrings(value, (s) => {
    if (!s.startsWith(BLOB_PREFIX)) return s;
    const hash = s.slice(BLOB_PREFIX.length);
    // Only a hex digest may name a file, so a reference can't point outside the blob folders.
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Bad blob reference: ${hash.slice(0, 80)}`);
    const file = blobPath(searched, hash);
    if (!file) throw new MissingBlobError(hash);
    const data = gunzipSync(readFileSync(file)).toString("utf8");
    if (createHash("sha256").update(data).digest("hex") !== hash) throw new Error(`Blob ${hash} is corrupt`);
    return data;
  });
}

/** Blob references in recorded JSON text that none of `dirs` holds. */
export function missingBlobs(text: string, dirs: readonly string[]): string[] {
  const hashes = new Set([...text.matchAll(/"@blob:([0-9a-f]{64})"/g)].map((m) => m[1] ?? ""));
  return [...hashes].filter((h) => !blobPath(dirs, h));
}

const LOADERS = new Set([
  "BPFLoader1111111111111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "LoaderV411111111111111111111111111111111111",
]);

/** An Anchor IDL account: 44-byte header, then zlib-compressed IDL JSON with instructions. */
function isIdlAccountData(bytes: Buffer): boolean {
  if (bytes.length < 46) return false;
  const length = bytes.readUInt32LE(40);
  if (length > bytes.length - 44) return false;
  try {
    const json = JSON.parse(inflateSync(bytes.subarray(44, 44 + length), { maxOutputLength: 16 * 1024 * 1024 }).toString("utf8")) as unknown;
    return typeof json === "object" && json !== null && "instructions" in json;
  } catch {
    return false;
  }
}

/**
 * Third-party material in recorded account data: program code (loader-owned accounts holding a
 * binary) and Anchor IDLs. Its data is replaced by a blob reference written to `dir`, whatever its
 * size, so recordings can be committed without it.
 */
export function externalizeThirdParty(value: unknown, dir: string): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v !== "object" || v === null) return v;
    const obj = v as Record<string, unknown>;
    const data = obj.data;
    if (Array.isArray(data) && typeof data[0] === "string" && data[1] === "base64" && typeof obj.owner === "string") {
      const b64 = data[0];
      const bytes = b64.startsWith(BLOB_PREFIX) ? null : Buffer.from(b64, "base64");
      const thirdParty = bytes !== null && ((LOADERS.has(obj.owner) && bytes.length > 1024) || isIdlAccountData(bytes));
      if (thirdParty) {
        const hash = createHash("sha256").update(b64).digest("hex");
        const file = `${dir}/${hash}.b64.gz`;
        if (!existsSync(file)) writeFileSync(file, gzipSync(b64, { level: 9 }));
        return { ...obj, data: [`${BLOB_PREFIX}${hash}`, ...data.slice(1)] };
      }
    }
    return Object.fromEntries(Object.entries(obj).map(([k, x]) => [k, walk(x)]));
  };
  return walk(value);
}
