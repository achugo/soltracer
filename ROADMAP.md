# Roadmap

SolTracer is built one phase at a time. The full specification and acceptance criteria are in [docs/build-prompt.md](docs/build-prompt.md).

## Done

- [x] **Phase 0: scaffold and private access.**
  - pnpm monorepo, with the engine bound to localhost behind a shared token.
  - Sign-in with an allowlisted wallet and encrypted sessions.
  - Checks against DNS rebinding and open redirects.
- [x] **Phase 1: RPC sandbox.**
  - Decodes legacy, v0 and v1 transactions, resolving lookup tables.
  - Simulates through Helius.
  - Decodes errors from IDLs and builtin error tables, and shows balance changes, fees and logs.
- [x] **Phase 2: landing optimizer.**
  - Sets the CU limit from a simulation and offers fee presets from recent fees, with contention detection.
  - Rewrites the blockhash and checks the result.
  - Hands the transaction to the wallet to sign and send, then checks its status.
- [x] **Phase 3: local execution.**
  - Runs transactions in LiteSVM against loaded mainnet state.
  - SOL, token and raw-data overrides.
  - Falls back to RPC, and saves runs.
  - LiteSVM runs in worker threads with a timeout.
- [x] **Phase 4, engine half: traces and state diffs.**
  - A CPI tree with CU per call and the failing call.
  - Anchor instruction and account decoding from on-chain IDLs.
  - Before/after account diffs.
  - Hardened against hostile IDLs.

## In progress

**Phase 5: live streamer and shareable runs**, on branch `feat/phase-5-streamer`.

- [x] Record real `logsSubscribe` sessions as test fixtures
- [x] Stream event and message schemas; the `best-effort` replay label on results
- [x] Database: stream events, run source, and runs readable by any allowlisted session
- [x] Parse notifications and hydrate transactions (block time, balance changes, errors)
- [ ] Helius WebSocket connection with reconnect, heartbeat and gap fill (`getSignaturesForAddress`)
- [ ] Re-run failed transactions automatically as best-effort replays
- [ ] Push events to the UI over the engine's WebSocket; serve `/runs/:id`
- [ ] Live feed page: signature, time, status, SOL and token changes, logs, trace link
- [ ] Run permalinks at `/runs/[id]`
- [ ] End-to-end tests: the feed, reconnecting without losing transactions, failures traced automatically
- [ ] Manual check on devnet: a transaction appears within 5 seconds and nothing is lost on reconnect

## Next

- [ ] **Live trace view (the Phase 4 UI).**
  - The CPI tree as a flame graph with the failing call highlighted.
  - Decoded arguments and account names.
  - Account diffs.
  - Its spec (`docs/live-trace-view.md`) is still to be written.
- [ ] **Phase 6: historical replay.**
  - Record account state over WebSocket for your wallets and chosen pools.
  - Replay a failure against the state at its original slot, marked `exact` or `best-effort`.
  - Cross-check balances against the chain.
  - Keep 30 days of history.

## Smaller items

- [ ] Paste a transaction signature (not just transaction bytes) into the sandbox
- [ ] A clearer error when someone pastes a 64-byte signature instead of a transaction
- [ ] Log repeated IDL cache-write failures (error code only)
- [ ] Deeper trace checks for version-1 transactions
- [ ] Label legacy (pre-0.30) Anchor zero-copy accounts, which can't be decoded reliably
- [ ] Render chain-supplied text (IDL names, logs) safely in the trace UI: plain text, and visible bidi and zero-width characters
