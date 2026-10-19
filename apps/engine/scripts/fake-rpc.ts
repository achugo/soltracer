/**
 * A local JSON-RPC server that answers from recorded simulator and optimizer sessions
 * (test/fixtures/sandbox/*.cmp.json, *.opt.json and *.sim.json; blobs from test/fixtures/blobs).
 * Used by e2e tests so the engine never calls Helius. Answers are repeatable: the same call always
 * gets its recorded response. Listens on 127.0.0.1 only.
 *
 *   tsx scripts/fake-rpc.ts [port]
 */
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { RpcCallRecord } from "../src/rpc/client.ts";
import { isJsonRpcPayload } from "@solana/kit";
import type { Address } from "@solana/kit";
import { anchorIdlAddress } from "../src/decode/idl-address.ts";
import { callKey, missingBlobs, parseRecordedJson, resolveBlobs } from "../src/rpc/replay.ts";

const DIR = fileURLToPath(new URL("../test/fixtures/sandbox/", import.meta.url));
// Committed blobs, then the local cache of third-party program binaries and IDLs (gitignored).
const BLOB_DIRS = [
  fileURLToPath(new URL("../test/fixtures/blobs", import.meta.url)),
  fileURLToPath(new URL("../test/fixtures/third-party", import.meta.url)),
];
const port = Number(process.argv[2] ?? 4199);

const { rawJSON } = JSON as unknown as { rawJSON(text: string): unknown };
const stringify = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? rawJSON(x.toString()) : x));

/** Recorded responses per call key, per recording file (insertion order = precedence order). */
const answers = new Map<string, Map<string, unknown>>();
/**
 * Some calls (getLatestBlockhash, shared mints) appear in several recordings with different answers.
 * Prefer the recording that most recently answered a call unique to one file: that is the
 * transaction being worked on, so a blockhash and the simulation that uses it stay consistent.
 */
// Process-wide state: e2e runs serially (workers: 1), so this follows one request flow at a time.
let currentFile: string | null = null;

function answer(key: string): unknown {
  const byFile = answers.get(key);
  if (!byFile) return undefined;
  if (byFile.size === 1) {
    const [[file, response]] = [...byFile] as [[string, unknown]];
    currentFile = file;
    return response;
  }
  if (currentFile && byFile.has(currentFile)) return byFile.get(currentFile);
  return [...byFile.values()].at(-1); // simulator recordings were loaded last and win
}
/** Every account state seen in any recorded getMultipleAccounts/getAccountInfo, by address. */
const accountsByAddress = new Map<string, { value: unknown; slot: bigint }>();

function indexAccounts(r: RpcCallRecord) {
  const result = (r.response as { result?: { context?: { slot?: bigint }; value?: unknown } }).result;
  const slot = result?.context?.slot ?? 0n;
  if (r.method === "getMultipleAccounts" && Array.isArray(r.params) && Array.isArray(r.params[0]) && Array.isArray(result?.value)) {
    (r.params[0] as string[]).forEach((address, i) => {
      // Later recordings win, matching exact-key precedence (simulator recordings load last).
      accountsByAddress.set(address, { value: (result.value as unknown[])[i] ?? null, slot });
    });
  }
  if (r.method === "getAccountInfo" && Array.isArray(r.params) && typeof r.params[0] === "string" && result) {
    accountsByAddress.set(r.params[0], { value: result.value ?? null, slot });
  }
}

/**
 * The engine caches lookup tables and mints, so a warm engine asks for a subset of what a cold
 * recording asked for. Only batched getMultipleAccounts is composed per address (never single
 * getAccountInfo reads, so an unbatched regression still fails), and every composed answer is
 * logged so unexpected re-fetches are visible.
 */
function composeAccountRead(method: string, params: unknown): unknown {
  if (method !== "getMultipleAccounts" || !Array.isArray(params) || !Array.isArray(params[0])) return undefined;
  const addresses = params[0] as string[];
  // Decoding reads the IDLs of a run's programs in one batch; unrecorded ones have no IDL account.
  const idlRead = addresses.some((a) => idlAddresses.has(a));
  const hits = addresses.map((a) => accountsByAddress.get(a) ?? (idlAddresses.has(a) ? { value: null, slot: 0n } : undefined));
  if (hits.some((h) => h === undefined)) return undefined;
  if (idlRead) idlBatchReads += 1;
  console.warn(`fake-rpc: composed getMultipleAccounts for ${addresses.length} accounts`);
  const slot = hits.reduce((max, h) => (h && h.slot > max ? h.slot : max), 0n);
  return { jsonrpc: "2.0", result: { context: { slot }, value: hits.map((h) => h?.value ?? null) } };
}
// Deterministic precedence, whatever the filesystem's order: optimizer recordings first, then
// simulator recordings, which win when both recorded the same call (the Sandbox specs assert exact deltas).
// Comparison recordings (rpc + local sessions, program binaries as blobs) load first, lowest precedence.
const files = readdirSync(DIR).sort();
const sessions: [string, RpcCallRecord[]][] = [];
/** A recorded session, unless it needs third-party material the local cache doesn't have (then it is skipped). */
function loadSession(source: string, calls: unknown): RpcCallRecord[] | null {
  if (missingBlobs(stringify(calls), BLOB_DIRS).length > 0) {
    console.warn(`fake-rpc: skipping ${source}: needs third-party fixtures missing from the local cache`);
    return null;
  }
  return resolveBlobs(calls, BLOB_DIRS) as RpcCallRecord[];
}

for (const file of files.filter((f) => f.endsWith(".cmp.json"))) {
  const cmp = parseRecordedJson(readFileSync(`${DIR}${file}`, "utf8")) as { rpc: unknown; local: unknown };
  for (const side of ["rpc", "local"] as const) {
    const calls = loadSession(`${file}#${side}`, cmp[side]);
    if (calls) sessions.push([`${file}#${side}`, calls]);
  }
}
for (const file of [...files.filter((f) => f.endsWith(".opt.json")), ...files.filter((f) => f.endsWith(".sim.json"))]) {
  const calls = loadSession(file, (parseRecordedJson(readFileSync(`${DIR}${file}`, "utf8")) as { rpc: unknown }).rpc);
  if (calls) sessions.push([file, calls]);
}
for (const [source, records] of sessions) {
  for (const r of records) {
    const key = callKey(r.method, r.params);
    const byFile = answers.get(key) ?? new Map<string, unknown>();
    byFile.delete(source); // re-insert so later sources keep precedence
    byFile.set(source, r.response);
    answers.set(key, byFile);
    indexAccounts(r);
  }
}

/**
 * Anchor IDL accounts of every executable program seen in the recordings. A run whose overrides make a
 * program fail looks up its IDL, which no recording captured; answer those (and only those) with
 * "no account", so the error shows raw instead of the fake failing the request.
 */
const idlAddresses = new Set<string>();
for (const [address, entry] of accountsByAddress) {
  const value = entry.value as { executable?: boolean } | null;
  if (value?.executable) idlAddresses.add(await anchorIdlAddress(address as Address));
}

/** How many IDL lookups were answered "no account"; e2e asserts successful runs cause none. */
let idlMisses = 0;
/** How many batched IDL reads (for decoding traces) were answered; e2e asserts repeat runs cause none. */
let idlBatchReads = 0;

function missingIdl(method: string, params: unknown): unknown {
  if (method !== "getAccountInfo" || !Array.isArray(params) || typeof params[0] !== "string") return undefined;
  if (!idlAddresses.has(params[0])) return undefined;
  idlMisses += 1;
  console.warn(`fake-rpc: no recorded IDL for ${params[0]}; answering "no account"`);
  return { jsonrpc: "2.0", result: { context: { slot: 0n }, value: null } };
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/__stats") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ idlMisses, idlBatchReads }));
    return;
  }
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString()));
  req.on("end", () => {
    let parsed: unknown;
    try {
      parsed = parseRecordedJson(body);
    } catch {
      parsed = null;
    }
    if (!isJsonRpcPayload(parsed)) {
      res.writeHead(400, { "content-type": "application/json" }).end('{"error":"expected a single JSON-RPC request"}');
      return;
    }
    const payload = parsed as typeof parsed & { id?: unknown };
    const recorded =
      answer(callKey(payload.method, payload.params)) ??
      composeAccountRead(payload.method, payload.params) ??
      missingIdl(payload.method, payload.params);
    const reply =
      typeof recorded === "object" && recorded !== null
        ? { ...recorded, id: payload.id }
        : { jsonrpc: "2.0", id: payload.id, error: { code: -32601, message: `fake-rpc: no recording for ${payload.method}` } };
    res.writeHead(200, { "content-type": "application/json" }).end(stringify(reply));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake-rpc listening on http://127.0.0.1:${port} with ${answers.size} distinct recorded calls`);
});
