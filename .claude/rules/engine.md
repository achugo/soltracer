---
paths:
  - "apps/engine/**"
---

# Engine rules

- Use `@solana/kit`; never import `@solana/web3.js` in the engine.
- All Helius traffic goes through `src/rpc/`. No other module creates a connection or calls `fetch` on the RPC URL.
- Config comes from the zod-validated config module, never `process.env` directly.
- Every route checks `ENGINE_TOKEN`. The server listens on `127.0.0.1` only.
- Validate outputs with `packages/shared` schemas before returning or emitting them.
- Errors: `{ ok: false, code, message, details }`. Never return a stack trace.
- Database access goes through drizzle in `src/db/`. Migrations must run up and down cleanly.
