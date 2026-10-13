import js from "@eslint/js";
import nextVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

const WEB_FILES = ["apps/web/**/*.{ts,tsx}"];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/next-env.d.ts",
      "apps/engine/drizzle/**",
    ],
  },
  js.configs.recommended,
  ...nextVitals.map((config) => ({ ...config, files: WEB_FILES })),
  { files: WEB_FILES, settings: { next: { rootDir: "apps/web" } } },
  ...tseslint.configs.strict,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // All Helius traffic goes through apps/engine/src/rpc (kit's transport); no ad-hoc fetch.
    files: ["apps/engine/src/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", { name: "fetch", message: "Use the RPC client in src/rpc/." }],
    },
  },
  {
    files: ["scripts/**/*.mjs", "**/*.config.{js,mjs,ts}"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
    rules: { "no-console": "off" },
  },
  {
    // CLI scripts print their results.
    files: ["apps/*/scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
);
