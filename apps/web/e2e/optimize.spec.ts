import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { allowedWallet } from "./env.ts";
import { signIn } from "./sign-in-helper.ts";
import { recordingsAvailable, THIRD_PARTY_SKIP_REASON } from "./third-party.ts";

function fixtureTx(name: string): string {
  const path = new URL(`../../engine/test/fixtures/sandbox/${name}.tx.json`, import.meta.url);
  const fx = JSON.parse(readFileSync(path, "utf8")) as { rpc: { response: { result: { transaction: [string] } } }[] };
  const tx = fx.rpc[0]?.response.result.transaction[0];
  if (!tx) throw new Error(`fixture ${name} has no transaction`);
  return tx;
}

async function simulateThenOptimize(page: Page, tx: string) {
  await page.getByRole("textbox", { name: /^Transaction/ }).fill(tx);
  await page.getByRole("button", { name: /simulate/i }).click();
  await expect(page.getByRole("region", { name: "Status" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Optimize for landing" }).click();
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("a recorded Jupiter swap is optimized: succeeds after rewrite, presets switch locally", async ({ page }) => {
  // The sandbox runs the swap locally first, which needs Jupiter's program binary.
  test.skip(!recordingsAvailable("jupiter-swap-fresh.cmp.json"), THIRD_PARTY_SKIP_REASON);
  await simulateThenOptimize(page, fixtureTx("jupiter-swap-fresh"));
  await expect(page.getByLabel("After status")).toContainText("After: succeeded in simulation");
  await expect(page.getByText("Signatures present.")).toBeVisible();

  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.getByRole("radio", { name: /p90/ }).check();
  await expect(page.getByRole("button", { name: /Sign and send with wallet \(p90\)/ })).toBeVisible();
  expect(requests.filter((u) => u.includes("/api/"))).toEqual([]); // switching presets costs nothing
});

test("someone else's transaction can't be sent from this wallet", async ({ page }) => {
  // The sandbox runs the swap locally first, which needs Jupiter's program binary.
  test.skip(!recordingsAvailable("jupiter-swap-fresh.cmp.json"), THIRD_PARTY_SKIP_REASON);
  await simulateThenOptimize(page, fixtureTx("jupiter-swap-fresh"));
  await expect(page.getByText(/Can't send/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Sign and send with wallet/ })).toBeDisabled();
});

test("a failure fees can't fix is refused with the decoded error", async ({ page }) => {
  test.skip(!recordingsAvailable("jupiter-slippage-6001.sim.json", "jupiter-slippage-6001.opt.json", "jupiter-slippage-6001.cmp.json"), THIRD_PARTY_SKIP_REASON);
  await simulateThenOptimize(page, fixtureTx("jupiter-slippage-6001"));
  const alert = page.getByRole("alert").filter({ hasText: "SlippageToleranceExceeded" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("0x1771");
});

/** An unsigned v0 memo transaction paid by the e2e wallet, plus a matching optimize result. */
function ownTransactionResult(signers: string[] = [allowedWallet.address]) {
  const payer = new PublicKey(allowedWallet.address);
  const blockhash = bs58.encode(new Uint8Array(32).fill(4));
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      new TransactionInstruction({
        programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        keys: signers.slice(1).map((s) => ({ pubkey: new PublicKey(s), isSigner: true, isWritable: false })),
        data: Buffer.from("soltracer e2e"),
      }),
    ],
  }).compileToV0Message();
  const tx = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
  const sim = {
    ok: true,
    encoding: "base64",
    version: 0,
    signed: false,
    accounts: signers.map((address, i) => ({ address, writable: i === 0, signer: true, source: { kind: "static" } })),
    computeBudget: { limit: 1_000, limitSource: "explicit", defaultLimit: 200_000, priceMicroLamports: "1000", priorityFeeLamports: "1", loadedAccountsDataSizeLimit: null },
    unitsConsumed: 700,
    status: { success: true },
    fee: { baseLamports: String(5000 * signers.length), priorityLamports: "1", totalLamports: String(5000 * signers.length + 1) },
    balances: { sol: [], tokens: [] },
    logs: [],
    slot: 1,
    credits: 3,
    engine: "rpc",
    fallbackReason: null,
    perInstruction: [],
    overrides: [],
    trace: { nodes: [], failingNodeId: null, complete: true },
    accountDiffs: [],
    replay: null,
    runId: null,
  };
  const preset = { priceMicroLamports: "1000", priorityFeeLamports: "1", totalFeeLamports: String(5000 * signers.length + 1), tx };
  return {
    tx,
    result: {
      ok: true,
      before: sim,
      after: sim,
      computeUnitLimit: 1_000,
      presets: { p50: preset, p75: preset, p90: preset },
      chosen: "p75",
      blockhash,
      lastValidBlockHeight: "300000150",
      contention: null,
      warnings: [],
      credits: 9,
    },
  };
}

test("sign and send hands the exact rewritten bytes to the wallet, then checks status on demand", async ({ page }) => {
  const own = ownTransactionResult();
  await page.route("**/api/optimize", (route) => route.fulfill({ json: own.result }));
  await page.route("**/api/tx-status", (route) =>
    route.fulfill({ json: { ok: true, status: { confirmationStatus: "confirmed", err: null, slot: 123 } } }),
  );
  await simulateThenOptimize(page, fixtureTx("sol-transfer"));

  await page.getByRole("button", { name: /Sign and send with wallet/ }).click();
  await expect(page.getByRole("link", { name: "View on Solscan" })).toBeVisible();

  const sent = await page.evaluate(() =>
    ((window as unknown as { __sent?: Uint8Array[] }).__sent ?? []).map((t) => btoa(String.fromCharCode(...t))),
  );
  expect(sent).toEqual([own.tx]); // the wallet got exactly the engine's unsigned transaction

  await page.getByRole("button", { name: "Check status" }).click();
  await expect(page.getByText(/Landed:/)).toContainText("confirmed");
});

test("a transaction that needs another signer is blocked and lists who must sign", async ({ page }) => {
  const other = bs58.encode(new Uint8Array(32).fill(9));
  const multi = ownTransactionResult([allowedWallet.address, other]);
  await page.route("**/api/optimize", (route) => route.fulfill({ json: multi.result }));
  await simulateThenOptimize(page, fixtureTx("sol-transfer"));
  await expect(page.getByText("Other required signers:")).toBeVisible();
  await expect(page.getByRole("button", { name: /Sign and send with wallet/ })).toBeDisabled();
});
