/**
 * Finds and records real mainnet transactions as test fixtures. Uses the engine's RPC
 * client (rate-limited, metered); never run from tests.
 *
 *   tsx scripts/fixtures.ts find <kind> [--max-credits N]
 *   tsx scripts/fixtures.ts record <signature> <name> [--force]
 *   tsx scripts/fixtures.ts record-idl <program> <name> [--force]
 *   tsx scripts/fixtures.ts simulate <fixture-name> [--force]   (runs the simulator, records its calls)
 *
 * kinds: jupiter-alt-success | jupiter-slippage-6001 | sol-transfer | token-2022-transfer | v1-transaction
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { address, signature as toSignature, type Signature } from "@solana/kit";
import { z } from "zod";
import { createMemoryCaches } from "../src/cache/memory.ts";
import { anchorIdlAddress } from "../src/decode/idl-address.ts";
import { simulateWithRpc } from "../src/sim/rpc-simulator.ts";
import { createRpcClient, type RpcCallRecord, type RpcSession } from "../src/rpc/client.ts";
import { createRateLimiter } from "../src/rpc/rate-limiter.ts";

const FIXTURE_DIR = fileURLToPath(new URL("../test/fixtures/sandbox/", import.meta.url));

const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SYSTEM = "11111111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const { HELIUS_RPC_URL } = z.object({ HELIUS_RPC_URL: z.url() }).parse(process.env);

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

interface Kind {
  program: string;
  /** Pre-filter on the signature list entry. */
  wantErr: (err: unknown) => boolean;
  /** Final check on the full transaction. */
  accept: (tx: { logs: string[]; loadedAddresses: number; version: unknown }) => boolean;
}

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
      if (kind.accept({ logs: [...(tx.meta.logMessages ?? [])], loadedAddresses: loaded, version: tx.version })) {
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
  const path = fileURLToPath(new URL(`../test/fixtures/idl/${name}.idl.json`, import.meta.url));
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
  await writeFile(outPath, `${stringify({ fixture: name, recordedAt: new Date().toISOString(), input: wire, rpc: records })}\n`);
  const summary = outcome.ok
    ? { status: outcome.result.status, unitsConsumed: outcome.result.unitsConsumed, credits: outcome.result.credits }
    : outcome.error;
  console.log(`Wrote ${outPath} (credits used: ${session.credits()})\n${stringify(summary)}`);
}

const [command, a, b, c] = process.argv.slice(2);
if (command === "find" && a) {
  const cap = b === "--max-credits" ? z.coerce.number().int().positive().parse(c) : 300;
  await find(a, cap);
} else if (command === "record" && a && b) await record(a, b, c === "--force");
else if (command === "record-idl" && a && b) await recordIdl(a, b, c === "--force");
else if (command === "simulate" && a) await recordSimulation(a, b === "--force");
else {
  console.error(
    "Usage: fixtures.ts find <kind> [--max-credits N] | record <signature> <name> [--force] | record-idl <program> <name> [--force]",
  );
  process.exit(1);
}
