---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/test/**"
  - "**/e2e/**"
---

# Testing rules

- Vitest for unit and integration tests; Playwright for end-to-end tests.
- Fixtures are real RPC responses saved as JSON, named by what they show (`jupiter-slippage-6001.json`).
- Tests never call mainnet or Helius. Use fixtures, or a local fake of the RPC client.
- No real wallet addresses of the user, keys or tokens in fixtures.
- Never weaken, skip or delete a test to make a change pass.
- Use fake timers for anything time-based; no real sleeps over 50 ms.
