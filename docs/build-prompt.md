# SolTracer — Build Prompt

## 1. Role and context

You are a senior TypeScript engineer building SolTracer, a private Solana transaction debugger. It does three things:

- Simulates transactions before broadcast, in a local SVM with state overrides.
- Fixes transactions that fail to land: CU limit, priority fee, fresh blockhash.
- Streams live activity for whitelisted wallets and auto-traces every failure.

Hard constraints:

- Solo and private. Only allowlisted wallet addresses can sign in. It runs on localhost, optionally reachable over Tailscale. Nothing is exposed publicly.
- $0/month. Use only the Helius free plan (1M credits/month, 10 RPC requests/second). No webhooks, no gRPC, no paid add-ons.
- Rate-limit aware. Every RPC call goes through one server-side client with caching, batching and a 10 req/s token bucket.
- No secrets in the browser. API keys live only in the server's env.

## 2. Stack

Versions are the latest on npm as of this date. Pin them with `^` in package.json.

| Layer | Package | Version | Why |
| --- | --- | --- | --- |
| Monorepo | pnpm workspaces | 12.x | Shared types between web and engine |
| Web app | next (App Router), react | 16.4, 19.3 | UI and the thin API proxy |
| Styling | tailwindcss, lucide-react | 4.3, 1.54 | Dark dev-tool UI |
| Client data | @tanstack/react-query | 5.104 | Caching and polling for API calls |
| Wallet | @solana/wallet-adapter-react, -react-ui, -wallets | 0.15.x | Phantom and Solflare sign-in only |
| Solana (web) | @solana/web3.js | 1.99 | Required by wallet adapter; web side only |
| Solana (engine) | @solana/kit, @solana-program/token, @solana-program/system | 8.4, 0.16, 0.14 | Modern SDK; what LiteSVM is built on |
| Execution | litesvm | 1.5 | Local SVM: overrides, full logs, traces |
| IDL decoding | @coral-xyz/anchor | 0.32 | Fetch on-chain IDLs, decode errors and accounts |
| Engine server | fastify, ws | 5.12, 8.22 | HTTP plus WebSocket to the UI |
| Validation | zod | 4.6 | Every API input and env var |
| Auth | tweetnacl, bs58, iron-session | 1.0, 6.0, 9.0 | Sign-in-with-wallet and encrypted session cookie |
| Database | Postgres 16 in Docker, drizzle-orm | 0.45 | Runs, account history, allowlist |
| Tests | vitest | 5.0 | Unit and fixture tests |
| RPC | Helius free plan | n/a | HTTP JSON-RPC and standard wss:// |

Transactions cross the web/engine boundary only as base64 strings, so the two Solana SDKs never mix.

## 3. Architecture and repo layout

Two processes plus Postgres, all local. The browser talks only to the Next.js app; the app proxies to the engine; only the engine talks to Helius.

- `apps/web` (Next.js, port 3000): UI, wallet sign-in, session check, proxy routes to the engine.
- `apps/engine` (Fastify, port 4000, bound to 127.0.0.1): RPC client, LiteSVM runner, decoders, streamer, account recorder, WebSocket hub for the UI.
- `packages/shared`: zod schemas and TypeScript types for every request and response.
- Postgres (Docker, port 5432).

```
soltracer/
  apps/
    web/
      app/(auth)/login/        # sign-in-with-wallet page
      app/sandbox/             # Tab 1: simulator
      app/stream/              # Tab 2: live feed
      app/runs/[id]/           # saved trace view
      app/api/                 # auth + proxy routes only
      components/
      lib/session.ts
    engine/
      src/rpc/                 # rate-limited, cached Helius client
      src/tx/                  # decode, ALT resolution, ComputeBudget parsing
      src/sim/                 # rpc simulator (P1) + litesvm runner (P3)
      src/decode/              # IDL fetch/cache, error + account decoding
      src/trace/               # CPI tree + CU attribution from logs
      src/optimize/            # landing optimizer
      src/stream/              # logsSubscribe consumer + hydration
      src/record/              # accountSubscribe history recorder (P6)
      src/replay/              # historical replay (P6)
      src/db/                  # drizzle schema + migrations
      test/fixtures/           # real mainnet tx bytes + expected results
  packages/shared/
  docker-compose.yml           # postgres
  .env.example
```

Env vars (validated with zod at boot, engine only unless noted): `HELIUS_API_KEY`, `HELIUS_RPC_URL`, `HELIUS_WSS_URL`, `DATABASE_URL`, `ALLOWLIST` (comma-separated pubkeys), `SESSION_SECRET` (web), `ENGINE_URL` (web), `ENGINE_TOKEN` (shared secret between web and engine).

## 4. Global rules

Apply these in every phase.

1. **One phase at a time.** Do not start the next phase until every acceptance criterion passes. Stop and report when a phase is done.
2. **Fixtures before features.** Each decoder, simulator and optimizer gets tests against real mainnet transaction bytes saved in `test/fixtures/`, including at least one failure and one versioned transaction with lookup tables.
3. **Never trust input.** Every API route parses with zod. Reject transactions over 1232 bytes (4096 for version-1 transactions). Detect base58 vs base64 and say which failed.
4. **Budget RPC.** Batch account reads with `getMultipleAccounts` (100 per call). Cache immutable data (program IDLs, lookup tables, mint decimals) in Postgres. Log credit usage per request.
5. **Typed errors.** The engine returns `{ ok: false, code, message, details }`, never a raw stack trace.
6. **Never sign or send.** The tool returns transactions for the user's wallet to sign. It holds no private keys.
7. **Honest labels.** Any result computed against current state rather than historical state is marked `best-effort` in the API and the UI.
8. **UI style.** `bg-neutral-950` base, `neutral-800` borders, violet accent, green success, red failure, `font-mono` for hashes, amounts and logs. Mobile width works but desktop is the target.

## 5. Phases

### Phase 0: Scaffold and private access

Goal: an empty app only allowlisted wallets can enter.

- pnpm monorepo, Docker Postgres, drizzle migrations, zod env validation, `.env.example`.
- Fastify engine bound to 127.0.0.1, accepting only requests carrying `ENGINE_TOKEN`.
- Sign-in-with-wallet:
  - `GET /api/auth/nonce` issues a single-use nonce (5-minute expiry, stored in Postgres).
  - The wallet signs `SolTracer login\nDomain: <host>\nNonce: <nonce>\nIssued: <ISO time>`. The web app only answers to hosts in `APP_HOSTS`, and the engine checks that the signed domain matches the request's host (DNS-rebinding guard).
  - `POST /api/auth/verify` checks the ed25519 signature with tweetnacl, checks the pubkey against `ALLOWLIST`, and sets an iron-session cookie (httpOnly, sameSite=strict).
- Middleware redirects every route except `/login` without a valid session.
- App shell: top bar with logo, wallet button and sign-out; Sandbox and Stream tabs.

Acceptance:

- [ ] A non-allowlisted wallet is refused with a clear message.
- [ ] A reused or expired nonce is refused.
- [ ] The engine refuses requests without `ENGINE_TOKEN`.
- [ ] No API key appears in the browser bundle (grep the build output).

### Phase 1: RPC sandbox

Goal: paste a transaction and see what it will do.

- Decode base58 or base64 into a VersionedTransaction (legacy, v0 or v1); resolve lookup tables (v0) to get the full account list.
- Parse ComputeBudget instructions (legacy/v0) or the message config (v1): CU limit (default 200k per non-budget instruction, max 1.4M), CU price or v1 total priority fee, and loaded-accounts data limit.
- Fetch pre-state of all writable accounts with `getMultipleAccounts`.
- `simulateTransaction` with `sigVerify: false`, `replaceRecentBlockhash: true`, and `accounts: { addresses: <writable>, encoding: 'base64' }`.
- Diff pre vs. post: SOL lamports, and SPL Token plus Token-2022 balances (decode the token account layout, look up mint decimals).
- Fee: `getFeeForMessage` for the base fee, plus CU limit × CU price for the priority fee (v1: the config's priority fee lamports).
- Errors: map InstructionError to the instruction index and program. Decode Anchor error codes (6000+) using the program's on-chain IDL, plus built-in tables for System, SPL Token and Anchor framework errors.
- UI:
  - Input textarea with encoding auto-detect.
  - Status card.
  - CU bar showing used vs. the transaction's own limit, with 1.4M noted.
  - Fee card.
  - Balance delta table grouped by owner.
  - Raw logs panel.

Acceptance:

- [ ] Fixtures for a Jupiter swap, a failed swap with slippage, and a plain SOL transfer produce the correct deltas, CU and decoded error.
- [ ] A transaction with lookup tables lists every resolved account.
- [ ] A version-1 fixture shows its config CU limit, a 241-lamport priority fee and a 5241-lamport total fee.
- [ ] One simulation costs 6 credits or fewer, as shown in the logs.

### Phase 2: Landing optimizer

Goal: turn a transaction that won't land into one that will.

- Simulate to get actual CU used; set the limit to `ceil(used × 1.15)`, capped at 1.4M.
- Call `getRecentPrioritizationFees` with the write-locked accounts; offer p50, p75 and p90 presets.
- Replace or insert the ComputeBudget instructions (legacy/v0) or rewrite the message config's CU limit and total priority fee (v1), set a fresh blockhash, and return the unsigned transaction as base64.
- Warn when a write-locked account appears in the recent fee data with high fees (contention).
- UI: before/after comparison and a "Sign and send with wallet" button. The wallet signs and sends; the engine never does.

Acceptance:

- [ ] The rewritten transaction simulates successfully and keeps every non-budget instruction byte-identical.
- [ ] Transactions that are already signed get a clear warning that rewriting invalidates existing signatures.

### Phase 3: Own the execution layer

Goal: simulate in a local SVM so overrides and full logs are possible.

- LiteSVM runner: load each account the transaction touches from mainnet (batched, cached by slot), including program accounts and executable data.
- Override UI: set SOL balance, token balance for a mint, or raw account data (base64) on any account before running.
- Disable log truncation; capture full logs and per-instruction CU.
- Engine toggle per run: `rpc` or `local`. Default `local`, falling back to `rpc` if loading fails, with the reason shown.
- Persist each run (input, overrides, result) to Postgres with an id.

Acceptance:

- [ ] For every Phase 1 fixture, local and rpc agree on success, error and balance deltas.
- [ ] Overriding a wallet's USDC balance makes a previously failing swap succeed.
- [ ] A cold run of a Jupiter route stays within the 10 req/s limit (token bucket verified in a test).

### Phase 4: Trace viewer and state diffs

Goal: see exactly where and why a transaction failed.

- Build the CPI tree from `Program X invoke [depth]`, `consumed N of M` and `success`/`failed` log lines.
- Show CU per node as a flame graph, with the failing node highlighted and its decoded error.
- Fetch and cache Anchor IDLs on-chain; decode instruction arguments and account names in the tree.
- Account diff: decoded fields (via IDL or known layouts) before and after, with raw byte diff as a fallback.

Acceptance:

- [ ] A failed multi-hop Jupiter fixture shows the failing hop, its program, its decoded error and the CU split.
- [ ] Programs without an IDL still render with program id and raw data.

### Phase 5: Live streamer and shareable runs

Goal: watch your wallets and debug failures automatically.

- Engine opens one Helius wss:// connection with a `logsSubscribe` per allowlisted wallet (`mentions` takes one pubkey each), commitment `confirmed`.
- Auto-reconnect with backoff and resubscribe; fill any gap on reconnect with `getSignaturesForAddress`.
- On each notification: store it, then hydrate with `getTransaction` (`maxSupportedTransactionVersion: 1`) for block time, balances and token changes.
- On failure: auto-run the Phase 3 engine against current state, labelled `best-effort`, and link the trace.
- Push events to the UI over the engine's own WebSocket (via the web app, session-checked).
- Feed UI: signature, time, status, SOL and token deltas, collapsible logs, link to the trace.
- Permalinks: `/runs/[id]` renders a saved run, viewable only by allowlisted sessions.

Acceptance:

- [ ] A devnet transaction from an allowlisted wallet appears in the feed within 5 seconds.
- [ ] Killing the connection mid-stream loses no transactions after reconnect.
- [ ] A failed transaction shows a trace link without user action.

### Phase 6: Historical replay (the hard part, last)

Goal: replay a failure against the state at its original slot.

- Recorder: on startup, `accountSubscribe` (commitment `confirmed`, encoding `base64`) to each allowlisted wallet, its token accounts, and a configurable list of pools and programs. Store every update with its slot.
- Discover new token accounts from hydrated transactions and subscribe to them automatically.
- Replay: for a signature, load the latest recorded state before its slot for each touched account; fall back to current state for unrecorded accounts.
- Mark the replay `exact` if every touched writable account had recorded state, otherwise `best-effort`, listing the missing accounts.
- Cross-check SOL and token pre-balances against `getTransaction` `meta.preBalances` and `meta.preTokenBalances`; flag mismatches.
- Retention: keep 30 days of history; prune daily.

Acceptance:

- [ ] A devnet failure on a recorded account replays with `exact` and the same error as on-chain.
- [ ] Recorder credit use is logged and stays under 50k credits a month for 3 wallets.
- [ ] Transactions from before recording started are refused with a clear reason, not silently replayed.

## 6. Out of scope

Do not build these unless asked:

- Public sign-up, multi-user accounts or billing.
- Webhooks, gRPC streams (LaserStream, Yellowstone) or any paid Helius feature.
- Backfilled history from before the recorder started.
- Signing or sending transactions from the server.
- Cloud deployment. Remote access is Tailscale only.
