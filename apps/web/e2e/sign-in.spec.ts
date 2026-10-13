import { expect, test } from "@playwright/test";
import { allowedWallet, strangerWallet } from "./env.ts";
import { installFakeWallet } from "./fake-wallet.ts";

test("signed-out visitors are sent to /login with a return path", async ({ page }) => {
  await page.goto("/stream");
  await expect(page).toHaveURL(/\/login\?next=%2Fstream$/);
  await expect(page.getByRole("link", { name: /install phantom/i })).toBeVisible();
});

test("an allowlisted wallet signs in, uses the shell and signs out", async ({ page }) => {
  await installFakeWallet(page, { name: "Phantom", ...allowedWallet });
  await page.goto("/stream");

  await page.getByRole("button", { name: "Connect Phantom" }).click();
  await expect(page.getByText(allowedWallet.address)).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/stream$/);
  await expect(page.getByRole("heading", { name: "Stream" })).toBeVisible();
  await expect(page.getByText(`Signed in as`)).toBeAttached();
  await expect(page.getByRole("link", { name: "Stream" })).toHaveAttribute("aria-current", "page");

  await page.getByRole("link", { name: "Sandbox" }).click();
  await expect(page.getByRole("heading", { name: "Sandbox" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/sandbox");
  await expect(page).toHaveURL(/\/login\?next=%2Fsandbox$/);
});

test("a wallet that is not allowlisted is refused with a clear message", async ({ page }) => {
  await installFakeWallet(page, { name: "Solflare", ...strangerWallet });
  await page.goto("/login");

  await page.getByRole("button", { name: "Connect Solflare" }).click();
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("alert").filter({ hasText: "allowlist" })).toContainText(
    "This wallet is not on the allowlist",
  );
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/sandbox");
  await expect(page).toHaveURL(/\/login/);
});
