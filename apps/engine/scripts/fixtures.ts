/**
 * Finds and records real mainnet transactions as test fixtures. Uses the engine's RPC
 * client (rate-limited, metered); never run from tests.
 *
 *   tsx scripts/fixtures.ts find <kind> [--max-credits N]
 *   tsx scripts/fixtures.ts record <signature> <name> [--force]
 *   tsx scripts/fixtures.ts record-idl <program> <name> [--force]
 *   tsx scripts/fixtures.ts simulate <fixture-name> [--force]   (runs the simulator, records its calls)
 *   tsx scripts/fixtures.ts optimize <fixture-name> [--force]   (runs the optimizer at p75, records its calls)
 *   tsx scripts/fixtures.ts compare <fixture-name> [--force]    (rpc then local, back to back; big data -> blobs/)
 *   tsx scripts/fixtures.ts record-stream <address> <name> [--force] (logsSubscribe frames, then the RPC calls hydration makes)
 *   tsx scripts/fixtures.ts fetch-third-party                  (fills the local cache of third-party binaries and IDLs)
 *
 * Third-party program binaries and Anchor IDLs are never written into committed recordings: they go to
 * test/fixtures/third-party/ (gitignored) and recordings refer to them by content hash.
 *
 * kinds: jupiter-alt-success | jupiter-slippage-6001 | jupiter-usdc-input | sol-transfer | token-2022-transfer | v1-transaction
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { address, signature as toSignature, type Signature } from "@solana/kit";
import { engineEnvSchema } from "@soltracer/shared";
import { z } from "zod";
import { createMemoryCaches } from "../src/cache/memory.ts";
import { anchorIdlAddress } from "../src/decode/idl-address.ts";
import { optimizeWithRpc } from "../src/optimize/optimizer.ts";
import { decodeTransactionInput } from "../src/tx/decode.ts";
import { simulateWithRpc } from "../src/sim/rpc-simulator.ts";
import { createProgramCache } from "../src/sim/local/loader.ts";
import { simulateLocally } from "../src/sim/local/local-simulator.ts";
import { externalizeBlobs, externalizeThirdParty, missingBlobs, parseRecordedJson } from "../src/rpc/replay.ts";
import { mkdirSync } from "node:fs";
import { createRpcClient, type RpcCallRecord, type RpcSession } from "../src/rpc/client.ts";
import { createRateLimiter } from "../src/rpc/rate-limiter.ts";
import WebSocket from "ws";

const FIXTURE_DIR = fileURLToPath(new URL("../test/fixtures/sandbox/", import.meta.url));

const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SYSTEM = "11111111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// Same rule as the engine: https, or plain http to loopback without a key.
const { HELIUS_RPC_URL } = engineEnvSchema.pick({ HELIUS_RPC_URL: true }).parse(process.env);
const STREAM_DIR = fileURLToPath(new URL("../test/fixtures/stream/", import.meta.url));
const THIRD_PARTY_DIR = fileURLToPath(new URL("../test/fixtures/third-party", import.meta.url));
mkdirSync(THIRD_PARTY_DIR, { recursive: true });
/** Program binaries and IDLs move out to the local cache before a recording is written. */
const withoutThirdParty = <T>(body: T): T => externalizeThirdParty(body, THIRD_PARTY_DIR) as T;

const client = createRpcClient({
  url: HELIUS_RPC_URL,
  limiter: createRateLimiter({ limit: 10, windowMs: 1000 }),
  log: {
    info: (obj, msg) => console.warn(msg, JSON.stringify(obj)),
    warn: (obj, msg) => console.warn(msg, JSON.stringify(obj)),
  },
});

/** Programs invoked at depth 1, from the logs. */
function topLevelPrograms(logs: readonly string[]): string[] {
  return logs.flatMap((l) => /^Program (\w+) invoke \[1\]$/.exec(l)?.[1] ?? []);
}

/** The Custom code in `{ InstructionError: [i, { Custom: n }] }`; kit gives n as a bigint. */
function customCode(err: unknown): number | null {
  const parsed = z
    .object({ InstructionError: z.tuple([z.unknown(), z.object({ Custom: z.union([z.number(), z.bigint()]) })]) })
    .safeParse(err);
  return parsed.success ? Number(parsed.data.InstructionError[1].Custom) : null;
}

interface TokenBalanceLite {
  mint: string;
  owner?: string;
  accountIndex: number;
  amount: bigint;
}

interface Kind {
  program: string;
  /** Pre-filter on the signature list entry. */
  wantErr: (err: unknown) => boolean;
  /** Final check on the full transaction. */
  accept: (tx: {
    logs: string[];
    loadedAddresses: number;
    version: unknown;
    pre: TokenBalanceLite[];
    post: TokenBalanceLite[];
    feePayer: string;
  }) => boolean;
}

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const KINDS: Record<string, Kind> = {
  "jupiter-alt-success": {
    program: JUPITER_V6,
    wantErr: (err) => err === null,
    accept: (tx) => tx.version === 0 && tx.loadedAddresses > 0,
  },
  "jupiter-slippage-6001": {
    program: JUPITER_V6,
    wantErr: (err) => customCode(err) === 6001,
    accept: (tx) => tx.loadedAddresses > 0,
  },
  "sol-transfer": {
    program: SYSTEM,
    wantErr: (err) => err === null,
    accept: (tx) => {
      const programs = topLevelPrograms(tx.logs);
      return programs.includes(SYSTEM) && programs.every((p) => p === SYSTEM || p === COMPUTE_BUDGET) &&
        programs.filter((p) => p === SYSTEM).length === 1 && tx.logs.length <= 8;
    },
  },
  "token-2022-transfer": {
    program: TOKEN_2022,
    wantErr: (err) => err === null,
    // Usually reached by CPI, so accept TransferChecked at any depth, right after a Token-2022 invoke.
    accept: (tx) =>
      tx.logs.some(
        (l, i) =>
          l === "Program log: Instruction: TransferChecked" &&
          (tx.logs[i - 1] ?? "").startsWith(`Program ${TOKEN_2022} invoke`),
      ) && tx.logs.length <= 40,
  },
  "jupiter-usdc-input": {
    program: JUPITER_V6,
    wantErr: (err) => err === null,
    // A swap where the fee payer spends their own USDC.
    accept: (tx) =>
      tx.version === 0 &&
      tx.pre.some(
        (b) =>
          b.mint === USDC &&
          b.owner === tx.feePayer &&
          (tx.post.find((p) => p.accountIndex === b.accountIndex)?.amount ?? 0n) < b.amount,
      ),
  },
  "v1-transaction": {
    program: SYSTEM,
    wantErr: (err) => err === null,
    accept: (tx) => tx.version === 1 && tx.logs.length <= 20,
  },
};

async function getTransaction(session: RpcSession, sig: Signature) {
  return session.rpc
    .getTransaction(sig, { encoding: "base64", maxSupportedTransactionVersion: 1, commitment: "confirmed" })
    .send();
}

async function find(kindName: string, maxCredits: number) {
  const kind = KINDS[kindName];
  if (!kind) throw new Error(`Unknown kind ${kindName}. One of: ${Object.keys(KINDS).join(", ")}`);
  const session = client.session();
  const program = await session.rpc.getAccountInfo(address(kind.program), { encoding: "base64" }).send();
  if (!program.value?.executable) throw new Error(`${kind.program} is not an executable program on mainnet`);
  let before: Signature | undefined;
  while (session.credits() < maxCredits) {
    const page = await session.rpc
      .getSignaturesForAddress(address(kind.program), { limit: 100, commitment: "confirmed", ...(before ? { before } : {}) })
      .send();
    if (page.length === 0) break;
    before = page.at(-1)?.signature;
    for (const entry of page.filter((e) => kind.wantErr(e.err))) {
      if (session.credits() >= maxCredits) break;
      const tx = await getTransaction(session, entry.signature);
      if (!tx?.meta) continue;
      const loaded = (tx.meta.loadedAddresses?.writable.length ?? 0) + (tx.meta.loadedAddresses?.readonly.length ?? 0);
      const lite = (list: readonly { mint: string; owner?: string; accountIndex: number; uiTokenAmount: { amount: string } }[] | null | undefined) =>
        (list ?? []).map((b) => ({ mint: b.mint, owner: b.owner, accountIndex: Number(b.accountIndex), amount: BigInt(b.uiTokenAmount.amount) }));
      const accepted = kind.accept({
        logs: [...(tx.meta.logMessages ?? [])],
        loadedAddresses: loaded,
        version: tx.version,
        pre: lite(tx.meta.preTokenBalances),
        post: lite(tx.meta.postTokenBalances),
        feePayer: (() => {
          const decoded = decodeTransactionInput(tx.transaction[0]);
          return decoded.ok ? (decoded.tx.staticAccounts[0] ?? "") : "";
        })(),
      });
      if (accepted) {
        console.log(`FOUND ${kindName}: ${entry.signature}  (credits used: ${session.credits()})`);
        return;
      }
    }
  }
  console.log(`No ${kindName} found within ${maxCredits} credits (used ${session.credits()}).`);
}

// Node 22 has JSON.rawJSON; TypeScript's ES2023 lib does not declare it yet.
const { rawJSON } = JSON as unknown as { rawJSON(text: string): unknown };

/**
 * kit's transport parses every JSON integer as a bigint. Writing them back as bare JSON
 * integers keeps fixtures identical to the wire format, so replay can parse them the same way.
 */
const stringify = (value: unknown) =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? rawJSON(v.toString()) : v), 2);

async function record(sig: string, name: string, force: boolean) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Fixture name must be kebab-case");
  const path = `${FIXTURE_DIR}${name}.tx.json`;
  if (existsSync(path) && !force) throw new Error(`${path} exists; pass --force to overwrite`);
  const records: RpcCallRecord[] = [];
  const session = client.session({ record: records });
  const tx = await getTransaction(session, toSignature(sig));
  if (!tx) throw new Error(`Transaction ${sig} not found`);
  await writeFile(path, `${stringify({ signature: sig, recordedAt: new Date().toISOString(), rpc: records })}\n`);
  console.log(`Wrote ${path} (credits used: ${session.credits()})`);
}

/** Records the getAccountInfo exchange for a program's on-chain Anchor IDL account. */
async function recordIdl(program: string, name: string, force: boolean) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Fixture name must be kebab-case");
  // A third-party IDL: kept in the local cache, never committed.
  const path = `${THIRD_PARTY_DIR}/${name}.idl.json`;
  if (existsSync(path) && !force) throw new Error(`${path} exists; pass --force to overwrite`);
  const idlAddress = await anchorIdlAddress(address(program));
  const records: RpcCallRecord[] = [];
  const session = client.session({ record: records });
  const account = await session.rpc.getAccountInfo(idlAddress, { encoding: "base64", commitment: "confirmed" }).send();
  if (!account.value) throw new Error(`No Anchor IDL account at ${idlAddress} for ${program}`);
  await writeFile(path, `${stringify({ program, idlAddress, recordedAt: new Date().toISOString(), rpc: records })}\n`);
  console.log(`Wrote ${path} (credits used: ${session.credits()})`);
}

/** Runs the real simulator (cold caches) on a recorded transaction and records every RPC exchange. */
async function recordSimulation(name: string, force: boolean) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Fixture name must be kebab-case");
  const txPath = `${FIXTURE_DIR}${name}.tx.json`;
  const outPath = `${FIXTURE_DIR}${name}.sim.json`;
  if (existsSync(outPath) && !force) throw new Error(`${outPath} exists; pass --force to overwrite`);
  const fixture = z
    .object({ rpc: z.array(z.object({ response: z.object({ result: z.object({ transaction: z.tuple([z.string(), z.string()]) }) }) })) })
    .parse(JSON.parse(await readFile(txPath, "utf8")));
  const wire = fixture.rpc[0]?.response.result.transaction[0];
  if (!wire) throw new Error(`${txPath} has no transaction`);

  const records: RpcCallRecord[] = [];
  const session = client.session({ record: records });
  const outcome = await simulateWithRpc(wire, session, createMemoryCaches());
  await writeFile(outPath, `${stringify(withoutThirdParty({ fixture: name, recordedAt: new Date().toISOString(), input: wire, rpc: records }))}\n`);
  const summary = outcome.ok
    ? { status: outcome.result.status, unitsConsumed: outcome.result.unitsConsumed, credits: outcome.result.credits }
    : outcome.error;
  console.log(`Wrote ${outPath} (credits used: ${session.credits()})\n${stringify(summary)}`);
}

/** Runs the optimizer (cold caches, p75) on a recorded transaction and records every RPC exchange. */
async function recordOptimization(name: string, force: boolean) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Fixture name must be kebab-case");
  const txPath = `${FIXTURE_DIR}${name}.tx.json`;
  const outPath = `${FIXTURE_DIR}${name}.opt.json`;
  if (existsSync(outPath) && !force) throw new Error(`${outPath} exists; pass --force to overwrite`);
  const fixture = z
    .object({ rpc: z.array(z.object({ response: z.object({ result: z.object({ transaction: z.tuple([z.string(), z.string()]) }) }) })) })
    .parse(JSON.parse(await readFile(txPath, "utf8")));
  const wire = fixture.rpc[0]?.response.result.transaction[0];
  if (!wire) throw new Error(`${txPath} has no transaction`);

  const records: RpcCallRecord[] = [];
  const session = client.session({ record: records });
  const outcome = await optimizeWithRpc({ tx: wire, preset: "p75" }, session, createMemoryCaches());
  await writeFile(outPath, `${stringify(withoutThirdParty({ fixture: name, recordedAt: new Date().toISOString(), input: wire, rpc: records }))}\n`);
  const summary = outcome.ok
    ? {
        limit: outcome.result.computeUnitLimit,
        before: outcome.result.before.unitsConsumed,
        after: outcome.result.after.status,
        presets: Object.fromEntries(Object.entries(outcome.result.presets).map(([k, v]) => [k, v.priceMicroLamports])),
        contention: outcome.result.contention,
        warnings: outcome.result.warnings.map((w) => w.code),
        credits: outcome.result.credits,
      }
    : outcome.error;
  console.log(`Wrote ${outPath} (credits used: ${session.credits()})\n${stringify(summary)}`);
}

const BLOB_DIR = fileURLToPath(new URL("../test/fixtures/blobs", import.meta.url));

/** Runs the rpc and local engines back to back (cold caches) and records both sessions. */
async function recordComparison(name: string, force: boolean) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Fixture name must be kebab-case");
  const txPath = `${FIXTURE_DIR}${name}.tx.json`;
  const outPath = `${FIXTURE_DIR}${name}.cmp.json`;
  if (existsSync(outPath) && !force) throw new Error(`${outPath} exists; pass --force to overwrite`);
  const fixture = z
    .object({ rpc: z.array(z.object({ response: z.object({ result: z.object({ transaction: z.tuple([z.string(), z.string()]) }) }) })) })
    .parse(JSON.parse(await readFile(txPath, "utf8")));
  const wire = fixture.rpc[0]?.response.result.transaction[0];
  if (!wire) throw new Error(`${txPath} has no transaction`);

  const rpcRecords: RpcCallRecord[] = [];
  const rpcSession = client.session({ record: rpcRecords });
  const rpcOutcome = await simulateWithRpc(wire, rpcSession, createMemoryCaches());
  const localRecords: RpcCallRecord[] = [];
  const localSession = client.session({ record: localRecords });
  const localOutcome = await simulateLocally(wire, [], localSession, createMemoryCaches(), createProgramCache());

  mkdirSync(BLOB_DIR, { recursive: true });
  // Program binaries and IDLs go to the local cache; other large account data (chain state) stays committed as blobs.
  const body = externalizeBlobs(
    withoutThirdParty({ fixture: name, recordedAt: new Date().toISOString(), input: wire, rpc: rpcRecords, local: localRecords }),
    BLOB_DIR,
  );
  await writeFile(outPath, `${stringify(body)}\n`);
  const summary = (o: typeof rpcOutcome) =>
    o.ok ? { status: o.result.status.success ? "success" : o.result.status.error.name ?? o.result.status.error.code, cu: o.result.unitsConsumed, credits: o.result.credits } : o.error.code;
  console.log(`Wrote ${outPath}\nrpc:   ${stringify(summary(rpcOutcome))}\nlocal: ${stringify(summary(localOutcome))}`);
}

/**
 * Records real logsSubscribe frames for an address (until at least one failure and `MIN_NOTIFICATIONS`
 * notifications arrive, or a time limit), then the RPC calls stream hydration makes: one
 * getSignaturesForAddress page and getTransaction for one successful and one failed notified signature.
 */
async function recordStream(target: string, name: string, force: boolean) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Fixture name must be kebab-case");
  mkdirSync(STREAM_DIR, { recursive: true });
  const path = `${STREAM_DIR}${name}.stream.json`;
  if (existsSync(path) && !force) throw new Error(`${path} exists; pass --force to overwrite`);
  const { HELIUS_WSS_URL } = engineEnvSchema.pick({ HELIUS_WSS_URL: true }).parse(process.env);
  const MIN_NOTIFICATIONS = 12;
  const MAX_NOTIFICATIONS = 60;
  const TIME_LIMIT_MS = 120_000;

  const frames: unknown[] = [];
  const notifications: { signature: string; err: unknown }[] = [];
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(HELIUS_WSS_URL);
    let finished = false;
    const done = () => {
      finished = true;
      clearTimeout(timer);
      socket.terminate();
      resolve();
    };
    const timer = setTimeout(done, TIME_LIMIT_MS);
    // Never surface the socket error itself: its message can include the URL (and api key).
    socket.on("error", () => {
      finished = true;
      clearTimeout(timer);
      reject(new Error("The Helius WebSocket connection failed"));
    });
    socket.on("close", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error("Helius closed the WebSocket before the recording finished"));
    });
    socket.on("open", () => {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [target] }, { commitment: "confirmed" }] }));
    });
    socket.on("message", (data) => {
      if (finished) return; // frames arriving while closing would make the recording nondeterministic
      const frame = parseRecordedJson(data.toString()) as { method?: string; params?: { result?: { value?: { signature?: string; err?: unknown } } } };
      frames.push(frame);
      const value = frame.method === "logsNotification" ? frame.params?.result?.value : undefined;
      if (value?.signature) notifications.push({ signature: value.signature, err: value.err ?? null });
      const failures = notifications.filter((n) => n.err !== null).length;
      if ((notifications.length >= MIN_NOTIFICATIONS && failures > 0) || notifications.length >= MAX_NOTIFICATIONS) done();
    });
  });
  const failed = notifications.find((n) => n.err !== null);
  const succeeded = notifications.find((n) => n.err === null);
  if (!failed || !succeeded) throw new Error(`Saw ${notifications.length} notifications but not both a success and a failure; try again`);

  const records: RpcCallRecord[] = [];
  const session = client.session({ record: records });
  await session.rpc.getSignaturesForAddress(address(target), { limit: 20, commitment: "confirmed" }).send();
  for (const n of [succeeded, failed]) await getTransaction(session, toSignature(n.signature));
  await writeFile(
    path,
    `${stringify({ address: target, recordedAt: new Date().toISOString(), succeeded: succeeded.signature, failed: failed.signature, frames, rpc: records })}\n`,
  );
  console.log(`Wrote ${path}: ${frames.length} frames, ${notifications.length} notifications (credits used: ${session.credits()})`);
}

/** Every account address whose recorded data is a blob reference, by hash (from the calls' params). */
function blobAddresses(calls: readonly RpcCallRecord[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const call of calls) {
    const params = call.params as unknown[] | undefined;
    const result = (call.response as { result?: { value?: unknown } }).result;
    const value = result?.value as unknown;
    const addresses: unknown[] =
      call.method === "getMultipleAccounts" ? ((params?.[0] as unknown[]) ?? [])
      : call.method === "getAccountInfo" ? [params?.[0]]
      : call.method === "simulateTransaction" ? ((params?.[1] as { accounts?: { addresses?: unknown[] } })?.accounts?.addresses ?? [])
      : [];
    const accounts =
      call.method === "simulateTransaction" ? ((value as { accounts?: unknown[] } | undefined)?.accounts ?? []) : Array.isArray(value) ? value : [value];
    accounts.forEach((account, i) => {
      const data = (account as { data?: unknown[] } | null)?.data?.[0];
      const address = addresses[i];
      if (typeof data === "string" && data.startsWith("@blob:") && typeof address === "string") found.set(data.slice(6), address);
    });
  }
  return found;
}

/**
 * Fills the local cache of third-party material the committed recordings refer to: re-reads each
 * account from mainnet and keeps it only if it still matches the recorded content hash. A program
 * upgraded since recording can't be restored; re-record that fixture (compare/simulate/optimize).
 */
async function fetchThirdParty() {
  const dirs = [BLOB_DIR, THIRD_PARTY_DIR];
  const wanted = new Map<string, string>();
  const referenced = new Map<string, string>();
  for (const file of (await readdir(FIXTURE_DIR)).filter((f) => /\.(cmp|sim|opt)\.json$/.test(f))) {
    const text = await readFile(`${FIXTURE_DIR}${file}`, "utf8");
    const missing = new Set(missingBlobs(text, dirs));
    const recording = parseRecordedJson(text) as { rpc?: RpcCallRecord[]; local?: RpcCallRecord[] };
    for (const [hash, address] of blobAddresses([...(recording.rpc ?? []), ...(recording.local ?? [])])) {
      referenced.set(hash, address);
      if (missing.has(hash)) wanted.set(hash, address);
    }
  }
  const session = client.session();
  const stale: string[] = [];
  const entries = [...wanted];
  for (let i = 0; i < entries.length; i += 100) {
    const batch = entries.slice(i, i + 100);
    const { value } = await session.rpc.getMultipleAccounts(batch.map(([, a]) => address(a)), { encoding: "base64", commitment: "confirmed" }).send();
    batch.forEach(([hash, account], j) => {
      const data = value[j]?.data[0];
      if (data && createHash("sha256").update(data).digest("hex") === hash) {
        writeFileSync(`${THIRD_PARTY_DIR}/${hash}.b64.gz`, gzipSync(data, { level: 9 }));
      } else {
        stale.push(account);
      }
    });
  }
  // The standalone IDL fixture must be the same IDL the recordings used: tests assert its exact contents.
  const idlPath = `${THIRD_PARTY_DIR}/jupiter-v6.idl.json`;
  if (!existsSync(idlPath)) {
    const idlAddress = await anchorIdlAddress(address(JUPITER_V6));
    const expected = [...referenced].find(([, a]) => a === idlAddress)?.[0];
    await recordIdl(JUPITER_V6, "jupiter-v6", false);
    const recorded = JSON.parse(await readFile(idlPath, "utf8")) as { rpc: { response: { result: { value: { data: [string] } } } }[] };
    const data = recorded.rpc[0]?.response.result.value.data[0] ?? "";
    if (createHash("sha256").update(data).digest("hex") !== expected) {
      rmSync(idlPath);
      stale.push(idlAddress);
    }
  }
  console.log(`Restored ${wanted.size - stale.length} of ${wanted.size} cached accounts (credits used: ${session.credits()}).`);
  if (stale.length > 0) {
    console.log(`Changed on-chain since recording (re-record the fixtures that use them): ${stale.join(", ")}`);
  }
}

const [command, a, b, c] = process.argv.slice(2);
if (command === "find" && a) {
  const cap = b === "--max-credits" ? z.coerce.number().int().positive().parse(c) : 300;
  await find(a, cap);
} else if (command === "record" && a && b) await record(a, b, c === "--force");
else if (command === "record-idl" && a && b) await recordIdl(a, b, c === "--force");
else if (command === "simulate" && a) await recordSimulation(a, b === "--force");
else if (command === "optimize" && a) await recordOptimization(a, b === "--force");
else if (command === "compare" && a) await recordComparison(a, b === "--force");
else if (command === "record-stream" && a && b) await recordStream(a, b, c === "--force");
else if (command === "fetch-third-party") await fetchThirdParty();
else {
  console.error(
    "Usage: fixtures.ts find <kind> [--max-credits N] | record <signature> <name> [--force] | record-idl <program> <name> [--force] | simulate|optimize|compare <name> [--force] | record-stream <address> <name> [--force] | fetch-third-party",
  );
  process.exit(1);
}
