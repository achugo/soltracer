import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL, E2E_WEB_PORT, e2eEnv } from "./e2e/env.ts";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  use: { baseURL: E2E_BASE_URL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @soltracer/engine db:migrate && pnpm --filter @soltracer/engine start",
      url: `${e2eEnv.ENGINE_URL}/health`,
      // /health needs the token; Playwright treats the 401 reply as "server is up".
      env: e2eEnv,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // A production build: closer to real use, and it can run while `pnpm dev` is up
      // (Next allows only one `next dev` per app directory).
      command: `pnpm exec next build && pnpm exec next start --hostname 127.0.0.1 --port ${E2E_WEB_PORT}`,
      url: `${E2E_BASE_URL}/login`,
      env: e2eEnv,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
