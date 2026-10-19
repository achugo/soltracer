import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import bs58 from "bs58";
import { signIn } from "./sign-in-helper.ts";
import { recordingsAvailable, THIRD_PARTY_SKIP_REASON } from "./third-party.ts";

/** The recorded mainnet transaction (base64) for an engine sandbox fixture. */
function fixtureTx(name: string): string {
  const path = new URL(`../../engine/test/fixtures/sandbox/${name}.tx.json`, import.meta.url);
  const fx = JSON.parse(readFileSync(path, "utf8")) as { rpc: { response: { result: { transaction: [string] } } }[] };
  const tx = fx.rpc[0]?.response.result.transaction[0];
  if (!tx) throw new Error(`fixture ${name} has no transaction`);
  return tx;
}

async function simulate(page: Page, tx: string) {
  await page.getByRole("textbox", { name: /^Transaction/ }).fill(tx);
  await page.getByRole("button", { name: /simulate/i }).click();
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("a SOL transfer simulates successfully with its CU, fee and balance changes", async ({ page }) => {
  await simulate(page, fixtureTx("sol-transfer"));
  const status = page.getByRole("region", { name: "Status" });
  await expect(status).toContainText("Success");
  await expect(page.getByRole("meter", { name: "Compute units used" })).toBeVisible();
  await expect(page.getByText("3 accounts")).toBeVisible();
  // 3,224,520 lamports moved, plus the 5,000-lamport fee.
  await expect(page.getByText("0.00322452").first()).toBeVisible();
  await expect(page.getByText("0.00322952").first()).toBeVisible();
});

test("a Jupiter swap with lookup tables lists every resolved account (RPC engine)", async ({ page }) => {
  // Recorded on RPC when this wallet still had funds; the toggle picks that engine explicitly.
  await page.getByRole("radio", { name: /^RPC/ }).check();
  await simulate(page, fixtureTx("jupiter-swap-alt"));
  await expect(page.getByRole("region", { name: "Status" })).toContainText("Success");
  await expect(page.getByText("24 accounts")).toBeVisible();
  await expect(page.getByTitle("Transaction version")).toHaveText("version v0");
});

test("a failed swap shows the decoded slippage error from the program's IDL", async ({ page }) => {
  // Runs locally by default (Jupiter and DEX binaries), then decodes with Jupiter's IDL.
  test.skip(!recordingsAvailable("jupiter-slippage-6001.sim.json", "jupiter-slippage-6001.cmp.json"), THIRD_PARTY_SKIP_REASON);
  await simulate(page, fixtureTx("jupiter-slippage-6001"));
  const status = page.getByRole("region", { name: "Status" });
  await expect(status).toContainText("Failed");
  await expect(status).toContainText("SlippageToleranceExceeded");
  await expect(status).toContainText("6001");
  await expect(status).toContainText("0x1771");
});

test("base58 input is detected and simulated too", async ({ page }) => {
  await simulate(page, bs58.encode(Buffer.from(fixtureTx("sol-transfer"), "base64")));
  await expect(page.getByRole("region", { name: "Status" })).toContainText("Success");
  await expect(page.getByTitle("Detected input encoding")).toHaveText("base58");
});

test("text that is not a transaction says which encodings were tried", async ({ page }) => {
  await simulate(page, "definitely-not-a-transaction");
  const alert = page.getByRole("alert").filter({ hasText: /base64/ });
  await expect(alert).toContainText("base58");
});
