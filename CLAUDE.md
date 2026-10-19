# SolTracer

Private Solana transaction debugger for one user. It simulates transactions in a local SVM (LiteSVM) with state overrides, fixes transactions that fail to land, streams live activity for allowlisted wallets, and shows every run as a live trace view.

## Source of truth

- `docs/build-prompt.md`: stack, architecture, global rules, Phases 0–6 with acceptance criteria.
- `docs/live-trace-view.md`: the live trace view, Steps 1–10 with exact commits. It replaces the trace viewer in Phase 4.
- Before starting a phase or step, read its section in full. If these docs and this file disagree, the docs win; tell me about the conflict.
- **Current work:** Phase 5 in progress on `feat/phase-5-streamer` (commits 1–4 of 10 done: fixtures, schemas, database, hydration). Phase 4's trace UI waits for `docs/live-trace-view.md`. Next: Phase 5 commit 5, the Helius socket with reconnect and gap fill (update this line when a phase or step is done).

## Hard constraints

- Solo and private. Only wallets in `ALLOWLIST` can sign in. Runs on localhost; remote access is Tailscale only.
- $0/month. Helius free plan only: 1M credits/month, 10 RPC requests/second. No webhooks, gRPC or paid features.
- Every RPC call goes through the engine's single rate-limited, cached client. Batch account reads with `getMultipleAccounts`.
- No secrets in the browser. Only `apps/engine` talks to Helius. The engine binds to 127.0.0.1 and requires `ENGINE_TOKEN`.
- Never sign or send a transaction from the server. The user's wallet signs.
- Results computed against current state instead of historical state are labelled `best-effort`, in the API and the UI.

## Repo map

- `apps/web`: Next.js App Router UI, wallet sign-in, session check, proxy routes to the engine. Uses `@solana/web3.js` v1 (wallet adapter needs it).
- `apps/engine`: Fastify service. RPC client, decoding, LiteSVM runner, log parser, optimizer, streamer, recorder. Uses `@solana/kit`.
- `packages/shared`: zod schemas and types shared by both. No Node or browser APIs.
- Transactions cross the web/engine boundary only as base64 strings. Never import one Solana SDK into the other app.

## Commands

Node 22 (`.nvmrc`), pnpm 12 via corepack. Copy `.env.example` to `.env` at the repo root; both apps read it.

- `docker compose up -d`: start Postgres (127.0.0.1:5432)
- `pnpm db:migrate` / `pnpm db:rollback`: apply / roll back the latest drizzle migration (down SQL in `apps/engine/drizzle/down/`)
- `pnpm db:generate`: generate a migration from `apps/engine/src/db/schema.ts`
- `pnpm dev`: run web (3000) and engine (4000), both on 127.0.0.1
- `pnpm typecheck` / `pnpm lint` / `pnpm test`: engine tests need Postgres running (they use `soltracer_test`)
- `pnpm e2e`: Playwright; starts its own engine (4100) and web (3100) with dummy env. First time: `pnpm --filter @soltracer/web exec playwright install chromium`
- `pnpm check:bundle`: builds web and fails if any secret value is in browser-facing output
- `pnpm --filter @soltracer/engine fixtures …`: find/record mainnet fixtures with your Helius key (spends credits; never run from tests). `find <kind>`, `record <sig> <name>`, `record-idl <program> <name>`, `simulate <name>` / `optimize <name>` (record the simulator's / optimizer's RPC calls for replay), `compare <name>` (rpc then local back to back), `fetch-third-party` (refill the local cache). Third-party program binaries and Anchor IDLs never go into committed recordings: they go to the gitignored `test/fixtures/third-party/` and recordings refer to them by content hash (`@blob:`). Only the four SPL binaries in `test/fixtures/blobs/` are committed (see THIRD_PARTY_NOTICES.md). Tests needing the cache skip with a reason when it's absent
- e2e runs the engine against `apps/engine/scripts/fake-rpc.ts`, which replays `test/fixtures/sandbox/*.cmp.json`, `*.opt.json` and `*.sim.json` (skipping any whose third-party material isn't in the local cache); it never calls Helius

## How we work

1. **One phase or step at a time.** Start each in plan mode: read the section, propose the plan, wait for my approval.
2. **Fixtures before features.** Parsers, decoders, simulators and reducers get tests against real mainnet transaction data in `test/fixtures/` before the implementation.
3. **Stop points.** At the end of each phase or step: print `git log --oneline main..HEAD`, list what was built and any deviation, then stop and wait for `next`.
4. **Ask before** adding a dependency not listed in the docs, changing the event contract, or touching another phase's scope.

## Git

- Never commit to `main`. One branch per phase (`feat/phase-0-scaffold`, `feat/phase-1-sandbox`, …) or feature (`feat/live-trace-view`).
- Commit only at the points the docs name. Before every commit run `pnpm typecheck && pnpm lint && pnpm test`; never commit red, never use `--no-verify`.
- Stage explicit paths (`git add <paths>`), never `git add -A`. Read `git diff --staged` first.
- Conventional Commits: `type(scope): summary`, imperative, under 72 characters. Types: feat, fix, test, refactor, chore, docs, perf. Scopes: shared, engine, db, web, e2e.
- Never commit `.env*` (except `.env.example`), keys, database dumps or real wallet addresses.
- Never push, force-push, rebase `main` or open a PR unless I ask.

## Subagents

Delegate to these (in `.claude/agents/`):

| Agent | Use it for |
| --- | --- |
| `test-engineer` | Fixtures and failing tests before any parser, decoder, simulator or reducer |
| `solana-engine` | Work in `apps/engine` and `packages/shared` |
| `web-ui` | Work in `apps/web` |
| `code-reviewer` | Review staged changes before every commit |
| `security-auditor` | End of every phase, and before any PR |

## Code standards

- TypeScript strict. No `any`, no non-null `!` without a comment saying why.
- zod at every boundary: env vars, API inputs, engine outputs, SSE messages.
- The engine returns `{ ok: false, code, message, details }`, never a raw stack trace.
- Small pure functions for parsing and layout; I/O at the edges.

## UI style

`bg-neutral-950` base, `neutral-800` borders, violet accent, green success, red failure. `font-mono` for hashes, amounts, ids and logs. Every state is shown by a label or icon as well as color. Controls are at least 44 px. Respect `prefers-reduced-motion`.
