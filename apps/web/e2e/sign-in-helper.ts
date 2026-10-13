import { expect, type Page } from "@playwright/test";
import { allowedWallet } from "./env.ts";
import { installFakeWallet } from "./fake-wallet.ts";

/** Signs in with the allowlisted test wallet and lands on `path`. */
export async function signIn(page: Page, path = "/sandbox") {
  await installFakeWallet(page, { name: "Phantom", ...allowedWallet });
  await page.goto(path);
  await page.getByRole("button", { name: "Connect Phantom" }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}
