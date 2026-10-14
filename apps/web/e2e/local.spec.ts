import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { E2E_FAKE_RPC_PORT } from "./env.ts";
import { signIn } from "./sign-in-helper.ts";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function fixtureTx(name: string): string {
  const path = new URL(`../../engine/test/fixtures/sandbox/${name}.tx.json`, import.meta.url);
  const fx = JSON.parse(readFileSync(path, "utf8")) as { rpc: { response: { result: { transaction: [string] } } }[] };
  const tx = fx.rpc[0]?.response.result.transaction[0];
  if (!tx) throw new Error(`fixture ${name} has no transaction`);
  return tx;
}

async function simulate(page: Page) {
  await page.getByRole("button", { name: /^simulate/i }).click();
}

/** IDL lookups the fake RPC had to answer "no account" so far (successful runs must cause none). */
async function idlMisses(): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${E2E_FAKE_RPC_PORT}/__stats`);
  return ((await res.json()) as { idlMisses: number }).idlMisses;
}

const status = (page: Page) => page.getByRole("region", { name: "Status" }).first();

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("runs locally by default and shows the engine, run id and full logs", async ({ page }) => {
  const before = await idlMisses();
  await page.getByRole("textbox", { name: /^Transaction/ }).fill(fixtureTx("sol-transfer"));
  await simulate(page);
  await expect(status(page)).toContainText("Success");
  expect(await idlMisses()).toBe(before); // a successful run looks up no IDL
  await expect(page.getByText("Local (LiteSVM)").first()).toBeVisible();
  await expect(page.getByText("Run id (saved)")).toBeVisible();
  await expect(page.getByText("Full logs")).toBeVisible();
});

test("a USDC override turns the swap into a failure at 0 and back into a success", async ({ page }) => {
  const before = await idlMisses();
  await page.getByRole("textbox", { name: /^Transaction/ }).fill(fixtureTx("jupiter-usdc-input"));
  await simulate(page);
  await expect(status(page)).toContainText("Success");
  expect(await idlMisses()).toBe(before);

  await page.getByRole("button", { name: "Add override" }).click();
  await page.getByLabel("Override 1 kind").selectOption("token");
  await page.getByRole("button", { name: "Use fee payer as owner" }).click();
  await page.getByLabel("Mint").fill(USDC);
  await page.getByLabel("Balance (tokens)").fill("0");
  await simulate(page);
  await expect(status(page)).toContainText("Failed");
  await expect(page.getByText(/Simulated with 1 override/)).toBeVisible();

  await page.getByLabel("Balance (tokens)").fill("1000000000");
  await simulate(page);
  await expect(status(page)).toContainText("Success");
  await expect(page.getByText(/not mainnet state/)).toBeVisible();
});

test("a local run that falls back to RPC says why", async ({ page }) => {
  // Pass the real engine response through, as the engine reports a fallback.
  await page.route("**/api/simulate", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, engine: "rpc", fallbackReason: "Program X uses an unsupported loader" } });
  });
  await page.getByRole("textbox", { name: /^Transaction/ }).fill(fixtureTx("sol-transfer"));
  await simulate(page);
  await expect(page.getByText("Ran on RPC instead of local:")).toBeVisible();
  await expect(page.getByText("Program X uses an unsupported loader")).toBeVisible();
});
