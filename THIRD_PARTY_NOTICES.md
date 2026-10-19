# Third-party notices

SolTracer's own code is under the MIT license (see [LICENSE](LICENSE)). This file lists material in
the repository that isn't SolTracer's own, and how third-party material is kept out of it.

## Included: Solana Program Library program binaries (test fixtures)

`apps/engine/test/fixtures/blobs/` contains the compiled on-chain binaries of four Solana Program
Library programs, read from Solana mainnet in October 2026 so the local engine can replay recorded
transactions offline:

- SPL Token
- SPL Token-2022
- SPL Associated Token Account
- SPL Memo

They are part of the Solana Program Library, published by Solana Labs / Anza under the
Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Source:
https://github.com/solana-program (formerly https://github.com/solana-labs/solana-program-library).
They are included unmodified.

## Not included: other programs' binaries and IDLs

The recorded test transactions also call other programs (for example Jupiter's aggregator and the
DEX programs it routes through), some of which are not open source. Their binaries, and Anchor IDLs
such as Jupiter's, are **not committed**. Recordings refer to them by content hash, and they are kept
in a local, gitignored cache (`apps/engine/test/fixtures/third-party/`).

- On a fresh clone the tests that need them are skipped with a clear reason; everything else runs.
- `pnpm --filter @soltracer/engine fixtures fetch-third-party` re-reads those accounts from mainnet
  and keeps the ones that still match the recording. Programs that have been upgraded since (common)
  can't be restored byte for byte; re-record the fixtures that use them (`fixtures compare <name>`,
  `simulate <name>`, `optimize <name>`), which writes new third-party material to the same local cache.

Earlier commits (13 October 2026 onwards) still contain copies of those binaries and of Jupiter's IDL;
they were removed from the current tree when this was noticed.

At runtime the app reads program binaries and IDLs from the chain, the same way any Solana client or
validator does, and caches them locally. Nothing read at runtime is committed.

## Recorded RPC data (test fixtures)

The fixtures in `apps/engine/test/fixtures/` are responses from Solana mainnet RPC (via Helius),
recorded with the author's own API key: public on-chain data (transactions, account state, logs and
public addresses) of unrelated third parties, used only to test decoders and simulators against real
input.

## Error names

`apps/engine/src/decode/builtin-errors.ts` lists error variant names from the Solana system program,
SPL Token and Anchor (all Apache License 2.0) so error codes can be labelled. No source code is copied.

## Dependencies

npm dependencies are installed from the registry under their own licenses and are not vendored here.
