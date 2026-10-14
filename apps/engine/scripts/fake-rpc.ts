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

const answers = new Map<string, unknown>();
// Deterministic precedence, whatever the filesystem's order: optimizer recordings first, then
// simulator recordings, which win when both recorded the same call (the Sandbox specs assert exact deltas).
const files = readdirSync(DIR).sort();
const ordered = [...files.filter((f) => f.endsWith(".opt.json")), ...files.filter((f) => f.endsWith(".sim.json"))];
for (const file of ordered) {
  const { rpc } = parseRecordedJson(readFileSync(`${DIR}${file}`, "utf8")) as { rpc: RpcCallRecord[] };
  for (const r of rpc) answers.set(callKey(r.method, r.params), r.response);
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
    const recorded = answers.get(callKey(payload.method, payload.params));
    const reply =
      typeof recorded === "object" && recorded !== null
        ? { ...recorded, id: payload.id }
        : { jsonrpc: "2.0", id: payload.id, error: { code: -32601, message: `fake-rpc: no recording for ${payload.method}` } };
    res.writeHead(200, { "content-type": "application/json" }).end(stringify(reply));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake-rpc listening on http://127.0.0.1:${port} with ${answers.size} recorded calls`);
});
