/**
 * A local JSON-RPC server that answers from recorded simulator and optimizer sessions
 * (test/fixtures/sandbox/*.sim.json and *.opt.json).
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
import { callKey, parseRecordedJson } from "../src/rpc/replay.ts";

const DIR = fileURLToPath(new URL("../test/fixtures/sandbox/", import.meta.url));
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
  const hits = addresses.map((a) => accountsByAddress.get(a));
  if (hits.some((h) => h === undefined)) return undefined;
  console.warn(`fake-rpc: composed getMultipleAccounts for ${addresses.length} accounts`);
  const slot = hits.reduce((max, h) => (h && h.slot > max ? h.slot : max), 0n);
  return { jsonrpc: "2.0", result: { context: { slot }, value: hits.map((h) => h?.value ?? null) } };
}
// Deterministic precedence, whatever the filesystem's order: optimizer recordings first, then
// simulator recordings, which win when both recorded the same call (the Sandbox specs assert exact deltas).
const files = readdirSync(DIR).sort();
const ordered = [...files.filter((f) => f.endsWith(".opt.json")), ...files.filter((f) => f.endsWith(".sim.json"))];
for (const file of ordered) {
  const { rpc } = parseRecordedJson(readFileSync(`${DIR}${file}`, "utf8")) as { rpc: RpcCallRecord[] };
  for (const r of rpc) {
    const key = callKey(r.method, r.params);
    const byFile = answers.get(key) ?? new Map<string, unknown>();
    byFile.delete(file); // re-insert so later files keep precedence
    byFile.set(file, r.response);
    answers.set(key, byFile);
    indexAccounts(r);
  }
}

const server = createServer((req, res) => {
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
    const recorded = answer(callKey(payload.method, payload.params)) ?? composeAccountRead(payload.method, payload.params);
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
