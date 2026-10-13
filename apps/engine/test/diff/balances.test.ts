import { address, getAddressEncoder, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../../src/decode/token-account.ts";
import { diffBalances, type AccountState } from "../../src/diff/balances.ts";

const enc = getAddressEncoder();
const SYSTEM = address("11111111111111111111111111111111");
const WALLET = address("SysvarRent111111111111111111111111111111111");
const OTHER = address("SysvarC1ock11111111111111111111111111111111");
const ATA = address("So11111111111111111111111111111111111111112");
const ATA2 = address("Stake11111111111111111111111111111111111111");
const MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const sol = (lamports: bigint): AccountState => ({ lamports, owner: SYSTEM, data: new Uint8Array() });
function token(program: Address, amount: bigint, owner: Address = WALLET): AccountState {
  const data = new Uint8Array(165);
  data.set(enc.encode(MINT), 0);
  data.set(enc.encode(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1;
  return { lamports: 2_039_280n, owner: program, data };
}

describe("diffBalances", () => {
  it("reports SOL changes and skips unchanged accounts", () => {
    const out = diffBalances([WALLET, OTHER], [sol(1_000_000_000n), sol(5n)], [sol(999_995_000n), sol(5n)]);
    expect(out.sol).toEqual([{ address: WALLET, pre: 1_000_000_000n, post: 999_995_000n, delta: -5_000n }]);
    expect(out.tokens).toEqual([]);
  });

  it("treats created and closed accounts as zero on the missing side", () => {
    const out = diffBalances([WALLET, OTHER], [null, sol(10n)], [sol(7n), null]);
    expect(out.sol).toEqual([
      { address: WALLET, pre: 0n, post: 7n, delta: 7n },
      { address: OTHER, pre: 10n, post: 0n, delta: -10n },
    ]);
  });

  it("reports token changes with the token account's owner and mint, beyond 2^53", () => {
    const big = 18_446_744_073_709_551_615n;
    const out = diffBalances([ATA, ATA2], [token(TOKEN_PROGRAM, 0n), token(TOKEN_2022_PROGRAM, 5n)], [token(TOKEN_PROGRAM, big), token(TOKEN_2022_PROGRAM, 5n)]);
    expect(out.tokens).toEqual([{ account: ATA, owner: WALLET, mint: MINT, program: "token", pre: 0n, post: big, delta: big }]);
    expect(out.mints).toEqual([MINT]);
  });

  it("handles token accounts that are created or closed", () => {
    const out = diffBalances([ATA, ATA2], [null, token(TOKEN_PROGRAM, 40n, OTHER)], [token(TOKEN_PROGRAM, 25n), null]);
    expect(out.tokens).toEqual([
      { account: ATA, owner: WALLET, mint: MINT, program: "token", pre: 0n, post: 25n, delta: 25n },
      { account: ATA2, owner: OTHER, mint: MINT, program: "token", pre: 40n, post: 0n, delta: -40n },
    ]);
  });

  it("requires pre and post lists that line up with the addresses", () => {
    expect(() => diffBalances([WALLET], [], [null])).toThrow(/line up/);
  });
});
