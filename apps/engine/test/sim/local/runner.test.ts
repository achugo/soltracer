import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from "@solana/kit";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import type { AccountSnapshot } from "../../../src/rpc/accounts.ts";
import {
  INSTRUCTION_ERRORS,
  liteSvmErrorToRpc,
  runLocal,
  TRANSACTION_ERRORS,
} from "../../../src/sim/local/runner.ts";

const SYSTEM = address("11111111111111111111111111111111");
// Ordinary (non-program, non-sysvar) addresses: LiteSVM ships builtins at the well-known ones.
const PAYER = address(bs58.encode(new Uint8Array(32).fill(7)));
const RECIPIENT = address(bs58.encode(new Uint8Array(32).fill(8)));
const CLOCK = { slot: 345_000_000n, epochStartTimestamp: 1_700_000_000n, epoch: 800n, leaderScheduleEpoch: 801n, unixTimestamp: 1_700_000_400n };

/** A System transfer of `lamports` from PAYER to RECIPIENT, unsigned. */
function transferTx(lamports: bigint): Uint8Array {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true); // SystemInstruction::Transfer
  new DataView(data.buffer).setBigUint64(4, lamports, true);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(PAYER, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n }, m),
    (m) =>
      appendTransactionMessageInstruction(
        { programAddress: SYSTEM, accounts: [{ address: PAYER, role: 3 }, { address: RECIPIENT, role: 1 }], data },
        m,
      ),
  );
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
}

const wallet = (addr: Address, lamports: bigint): AccountSnapshot => ({ address: addr, lamports, owner: SYSTEM, executable: false, data: new Uint8Array() });

describe("runLocal", () => {
  it("runs a transfer in LiteSVM with signatures and blockhash unchecked", () => {
    const out = runLocal({
      wire: transferTx(1_000_000n),
      accounts: new Map<Address, AccountSnapshot | null>([[PAYER, wallet(PAYER, 10_000_000n)], [RECIPIENT, null]]),
      programs: [],
      clock: CLOCK,
    });
    expect(out.err).toBeNull();
    expect(out.logs).toContain(`Program ${SYSTEM} success`);
    expect(out.post.get(RECIPIENT)?.lamports).toBe(1_000_000n);
    expect(out.post.get(PAYER)?.lamports).toBe(10_000_000n - 1_000_000n - 5_000n); // fee charged
  });

  it("reports a failure in the same shape as RPC simulateTransaction", () => {
    const out = runLocal({
      wire: transferTx(50_000_000n),
      accounts: new Map<Address, AccountSnapshot | null>([[PAYER, wallet(PAYER, 10_000_000n)], [RECIPIENT, null]]),
      programs: [],
      clock: CLOCK,
    });
    expect(out.err).toEqual({ InstructionError: [0, { Custom: 1 }] }); // ResultWithNegativeLamports
    expect(out.post.size).toBe(0);
  });

  it("reports a missing fee payer as a transaction-level error", () => {
    const out = runLocal({ wire: transferTx(1n), accounts: new Map<Address, AccountSnapshot | null>([[RECIPIENT, null]]), programs: [], clock: CLOCK });
    expect(out.err).toBe("AccountNotFound");
  });
});

describe("liteSvmErrorToRpc", () => {
  const named = (name: string, fields: object) => Object.assign(Object.create({ constructor: { name } }), fields);

  it("converts every error shape LiteSVM can return", () => {
    expect(liteSvmErrorToRpc(4)).toBe("InsufficientFundsForFee");
    expect(liteSvmErrorToRpc(named("TransactionErrorInstructionError", { index: 2, err: () => 36 }))).toEqual({
      InstructionError: [2, "ComputationalBudgetExceeded"],
    });
    expect(liteSvmErrorToRpc(named("TransactionErrorInstructionError", { index: 3, err: () => named("InstructionErrorCustom", { code: 6001 }) }))).toEqual({
      InstructionError: [3, { Custom: 6001 }],
    });
    expect(liteSvmErrorToRpc(named("TransactionErrorInstructionError", { index: 0, err: () => named("InstructionErrorBorshIO", { msg: "bad" }) }))).toEqual({
      InstructionError: [0, { BorshIoError: "bad" }],
    });
    expect(liteSvmErrorToRpc(named("TransactionErrorInsufficientFundsForRent", { accountIndex: 4 }))).toEqual({
      InsufficientFundsForRent: { account_index: 4 },
    });
    expect(liteSvmErrorToRpc(named("TransactionErrorDuplicateInstruction", { index: 1 }))).toEqual({ DuplicateInstruction: 1 });
    expect(liteSvmErrorToRpc(named("TransactionErrorProgramExecutionTemporarilyRestricted", { accountIndex: 2 }))).toEqual({
      ProgramExecutionTemporarilyRestricted: { account_index: 2 },
    });
  });

  it("keeps its enum tables in step with the installed litesvm", () => {
    const require = createRequire(import.meta.url);
    const dts = readFileSync(require.resolve("litesvm").replace(/index\.js$/, "internal.d.ts"), "utf8");
    const enumNames = (name: string) =>
      [...(new RegExp(`export declare const enum ${name} \\{([^}]*)\\}`).exec(dts)?.[1] ?? "").matchAll(/(\w+) = (\d+)/g)].map(
        (m) => [Number(m[2]), m[1]],
      );
    expect(enumNames("TransactionErrorFieldless")).toEqual(TRANSACTION_ERRORS.map((n, i) => [i, n]));
    expect(enumNames("InstructionErrorFieldless")).toEqual(INSTRUCTION_ERRORS.map((n, i) => [i, n]));
  });
});
