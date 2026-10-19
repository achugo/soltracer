# SolTracer

A private Solana transaction debugger that runs on your own machine. Paste a transaction to see exactly what it will do and why it fails. You can then:

- re-run it locally with state overrides;
- fix the compute budget, priority fee and blockhash so it lands;
- have your wallet sign and send the fixed version.

SolTracer is built for one person: a Solana developer or power user debugging their own transactions. Only allowlisted wallets can sign in. It runs on localhost, reachable remotely only over Tailscale, and it is designed to cost $0 a month on the Helius free plan.

## What it does today

- **Sign in with your wallet.**
  - Phantom or Solflare, through Wallet Standard.
  - Only addresses in `ALLOWLIST` get a session, and the engine re-checks every request against it.
- **Sandbox simulator.**
  - **Input:** a legacy, v0 (address lookup tables) or version-1 transaction, in base64 or base58.
  - **Engines:** simulate it through Helius RPC, or locally in [LiteSVM](https://github.com/LiteSVM/litesvm) against mainnet state loaded on demand. A local run that can't load state falls back to RPC and says why.
  - **Results:**
    - success or the decoded error (Anchor IDL errors, System and Token errors, and which CPI raised it);
    - SOL and token balance changes;
    - fees and compute budget;
    - CU per instruction;
    - full logs.
  - **Saved:** every run is stored with an id.
- **State overrides (local engine).** Set a SOL balance, a token balance (creating the associated token account if needed) or raw account data before a run, to ask "what if".
- **Landing optimizer.**
  - Sets the compute-unit limit from a real simulation, with headroom.
  - Offers p50/p75/p90 priority-fee presets from recent fees and flags hot accounts.
  - Swaps in a fresh blockhash.
  - Hands the unsigned transaction to your wallet to sign and send. The server never signs.
  - Lets you check whether it landed.
- **Trace engine (API only for now).** Every run returns:
  - a CPI tree with the CU spent per call and the failing call marked;
  - instruction arguments and account names decoded from the program's on-chain Anchor IDL;
  - before/after account diffs, decoded for system, token and IDL-defined accounts, and raw byte ranges otherwise.

  The UI for this is still to come; see [ROADMAP.md](ROADMAP.md).

In progress: a live stream of your wallets' transactions, where each failure is automatically re-run and traced.

## Built with

| Part | Stack |
| --- | --- |
| Web app (`apps/web`) | Next.js 16 (App Router), React 19, Tailwind CSS 4, TanStack Query, Solana wallet adapter + `@solana/web3.js` (wallet side only), iron-session |
| Engine (`apps/engine`) | Fastify 5, `@solana/kit`, LiteSVM (in worker threads), drizzle-orm, `ws` |
| Shared (`packages/shared`) | zod schemas and types for every request, response and message |
| Storage | Postgres 16 in Docker |
| RPC | Helius free plan (HTTP JSON-RPC and standard WebSocket) |
| Tests | Vitest, Playwright |

The browser only talks to the Next.js app. The app proxies to the engine, and only the engine talks to Helius. The engine binds to `127.0.0.1` and requires a shared `ENGINE_TOKEN`. Every RPC call goes through one rate-limited (10 requests/second), cached, credit-metered client.

## Running it

### Prerequisites

- Node.js 22.12 or later (see `.nvmrc`)
- pnpm 12, via `corepack enable`
- Docker, for Postgres
- A free [Helius](https://www.helius.dev/) API key

### Setup

```bash
git clone <this repository>
cd soltracer
corepack enable
pnpm install

cp .env.example .env
# Edit .env:
#   HELIUS_API_KEY, HELIUS_RPC_URL, HELIUS_WSS_URL  your Helius key and URLs
#   ALLOWLIST                                       your wallet address(es), comma-separated
#   SESSION_SECRET, ENGINE_TOKEN                    generate each with: openssl rand -base64 32

docker compose up -d   # Postgres on 127.0.0.1:5432
pnpm db:migrate        # apply database migrations
pnpm dev               # web on http://127.0.0.1:3000, engine on 127.0.0.1:4000
```

Open http://127.0.0.1:3000 and sign in with an allowlisted wallet. Then paste a transaction into **Sandbox**. It must be the transaction's bytes (base64 or base58), for example from a script or your app's serialized transaction, not a signature; pasting a signature is on the roadmap.

For remote access, put the machine on Tailscale and add its Tailscale hostname to `APP_HOSTS`. Don't expose the ports publicly.

### Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run the web app and the engine |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | Type checks, lint, unit and integration tests (the engine tests need Postgres running) |
| `pnpm e2e` | Playwright end-to-end tests against a fake RPC that replays recorded mainnet data (no Helius calls). First run: `pnpm --filter @soltracer/web exec playwright install chromium` |
| `pnpm check:bundle` | Build the web app and fail if any secret appears in browser-facing output |
| `pnpm db:migrate` / `pnpm db:rollback` | Apply or roll back the latest migration |
| `pnpm db:generate` | Generate a migration from `apps/engine/src/db/schema.ts` |
| `pnpm --filter @soltracer/engine fixtures …` | Find and record mainnet fixtures with your Helius key (spends credits; never run by tests) |

## Tests

Parsers, decoders, simulators and the optimizer are tested against real mainnet transactions in `apps/engine/test/fixtures/`. They cover:

- a failed multi-hop Jupiter swap;
- versioned transactions with lookup tables;
- a version-1 transaction;
- Token-2022 transfers.

Each fixture comes with the RPC calls recorded at the time, so tests replay them and never touch the network.

## Repository layout

```
apps/
  web/          Next.js UI, wallet sign-in, session checks, proxy routes to the engine
  engine/       Fastify service: RPC client, decoding, LiteSVM runner, trace builder, optimizer, streamer
    src/
      rpc/      rate-limited, cached, metered Helius client
      tx/       transaction decoding, lookup tables, compute budget
      decode/   IDL fetch and decoding, borsh, error decoding, token layouts
      sim/      RPC simulator and LiteSVM local engine
      trace/    CPI tree, account diffs
      optimize/ landing optimizer
      stream/   live wallet stream (in progress)
      db/       drizzle schema and migrations
    test/fixtures/  recorded mainnet transactions and RPC sessions
packages/
  shared/       zod schemas and types shared by both apps
docs/
  build-prompt.md   the full specification, phase by phase
```

## Security notes

- No secrets in the browser. Only the engine holds the Helius key, and `pnpm check:bundle` verifies that nothing secret reaches the client bundle.
- The server never signs or sends a transaction. Your wallet does.
- Every input is validated with zod. Data from the chain (IDLs, logs, account data) is treated as untrusted: decoding is size- and depth-limited and falls back to raw bytes rather than failing.
- Results computed against current state instead of the state at the time are labelled `best-effort`.

## Status and plans

SolTracer is under active development, built phase by phase from [docs/build-prompt.md](docs/build-prompt.md). See [ROADMAP.md](ROADMAP.md) for what's done and what's next.

## License

See [LICENSE](LICENSE).
