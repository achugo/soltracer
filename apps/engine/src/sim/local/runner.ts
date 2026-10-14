import { getTransactionDecoder, lamports, type Address } from "@solana/kit";
import { Clock, FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import type { AccountSnapshot } from "../../rpc/accounts.ts";
import type { AccountState } from "../../diff/balances.ts";
import type { ClockValues, LoadedProgram } from "./loader.ts";

/** litesvm's TransactionErrorFieldless, in enum order (its const enums don't exist at runtime). */
export const TRANSACTION_ERRORS = [
  "AccountInUse", "AccountLoadedTwice", "AccountNotFound", "ProgramAccountNotFound", "InsufficientFundsForFee",
  "InvalidAccountForFee", "AlreadyProcessed", "BlockhashNotFound", "CallChainTooDeep", "MissingSignatureForFee",
  "InvalidAccountIndex", "SignatureFailure", "InvalidProgramForExecution", "SanitizeFailure", "ClusterMaintenance",
  "AccountBorrowOutstanding", "WouldExceedMaxBlockCostLimit", "UnsupportedVersion", "InvalidWritableAccount",
  "WouldExceedMaxAccountCostLimit", "WouldExceedAccountDataBlockLimit", "TooManyAccountLocks",
  "AddressLookupTableNotFound", "InvalidAddressLookupTableOwner", "InvalidAddressLookupTableData",
  "InvalidAddressLookupTableIndex", "InvalidRentPayingAccount", "WouldExceedMaxVoteCostLimit",
  "WouldExceedAccountDataTotalLimit", "MaxLoadedAccountsDataSizeExceeded", "ResanitizationNeeded",
  "InvalidLoadedAccountsDataSizeLimit", "UnbalancedTransaction", "ProgramCacheHitMaxLimit", "CommitCancelled",
] as const;

/** litesvm's InstructionErrorFieldless, in enum order. */
export const INSTRUCTION_ERRORS = [
  "GenericError", "InvalidArgument", "InvalidInstructionData", "InvalidAccountData", "AccountDataTooSmall",
  "InsufficientFunds", "IncorrectProgramId", "MissingRequiredSignature", "AccountAlreadyInitialized",
  "UninitializedAccount", "UnbalancedInstruction", "ModifiedProgramId", "ExternalAccountLamportSpend",
  "ExternalAccountDataModified", "ReadonlyLamportChange", "ReadonlyDataModified", "DuplicateAccountIndex",
  "ExecutableModified", "RentEpochModified", "NotEnoughAccountKeys", "AccountDataSizeChanged", "AccountNotExecutable",
  "AccountBorrowFailed", "AccountBorrowOutstanding", "DuplicateAccountOutOfSync", "InvalidError",
  "ExecutableDataModified", "ExecutableLamportChange", "ExecutableAccountNotRentExempt", "UnsupportedProgramId",
  "CallDepth", "MissingAccount", "ReentrancyNotAllowed", "MaxSeedLengthExceeded", "InvalidSeeds", "InvalidRealloc",
  "ComputationalBudgetExceeded", "PrivilegeEscalation", "ProgramEnvironmentSetupFailure", "ProgramFailedToComplete",
  "ProgramFailedToCompile", "Immutable", "IncorrectAuthority", "AccountNotRentExempt", "InvalidAccountOwner",
  "ArithmeticOverflow", "UnsupportedSysvar", "IllegalOwner", "MaxAccountsDataAllocationsExceeded",
  "MaxAccountsExceeded", "MaxInstructionTraceLengthExceeded", "BuiltinProgramsMustConsumeComputeUnits", "BorshIoError",
] as const;

const kindOf = (value: unknown) =>
  typeof value === "object" && value !== null ? (Object.getPrototypeOf(value) as { constructor?: { name?: string } })?.constructor?.name : undefined;
const field = <T>(value: unknown, key: string): T => (value as Record<string, T>)[key] as T;

function instructionErrorToRpc(inner: unknown): unknown {
  if (typeof inner === "number") return INSTRUCTION_ERRORS[inner] ?? `UnknownInstructionError${inner}`;
  switch (kindOf(inner)) {
    case "InstructionErrorCustom":
      return { Custom: field<number>(inner, "code") };
    case "InstructionErrorBorshIO":
    case "InstructionErrorBorshIo":
      return { BorshIoError: field<string>(inner, "msg") };
    default:
      return String(inner);
  }
}

/** Converts a LiteSVM transaction error into the JSON shape RPC simulateTransaction returns. */
export function liteSvmErrorToRpc(err: unknown): unknown {
  if (typeof err === "number") return TRANSACTION_ERRORS[err] ?? `UnknownTransactionError${err}`;
  switch (kindOf(err)) {
    case "TransactionErrorInstructionError":
      return { InstructionError: [field<number>(err, "index"), instructionErrorToRpc(field<() => unknown>(err, "err").call(err))] };
    case "TransactionErrorInsufficientFundsForRent":
      return { InsufficientFundsForRent: { account_index: field<number>(err, "accountIndex") } };
    case "TransactionErrorDuplicateInstruction":
      return { DuplicateInstruction: field<number>(err, "index") };
    case "TransactionErrorProgramExecutionTemporarilyRestricted":
      return { ProgramExecutionTemporarilyRestricted: { account_index: field<number>(err, "accountIndex") } };
    default:
      // A class this version doesn't know: make clear it isn't a real RPC variant name.
      return `Unknown(${String(err)})`;
  }
}

export interface LocalRunInput {
  /** Wire bytes of the transaction (signatures may be empty). */
  wire: Uint8Array;
  /** Accounts to install; null means "does not exist". */
  accounts: ReadonlyMap<Address, AccountSnapshot | null>;
  programs: readonly LoadedProgram[];
  clock: ClockValues;
}

/** One CPI, as plain data (it crosses the worker boundary). Indices are into the transaction's accounts. */
export interface InnerInstruction {
  programIdIndex: number;
  accounts: number[];
  data: Uint8Array;
  stackHeight: number;
}

export interface LocalRunOutput {
  /** null on success; otherwise the RPC-shaped error. */
  err: unknown;
  logs: string[];
  /** CPIs per top-level instruction, in execution order. */
  inner: InnerInstruction[][];
  unitsConsumed: bigint;
  /** Post-state of the transaction's accounts (empty when it failed). */
  post: Map<Address, AccountState>;
}

/**
 * Runs one transaction in a fresh LiteSVM: no signature or blockhash checks, no log truncation,
 * the given accounts and programs installed and the clock set to mainnet's.
 * @throws if the transaction can't be decoded or a program's ELF is rejected; callers fall back to rpc.
 */
export function runLocal({ wire, accounts, programs, clock }: LocalRunInput): LocalRunOutput {
  const svm = new LiteSVM().withSigverify(false).withBlockhashCheck(false).withLogBytesLimit(undefined);
  for (const account of accounts.values()) {
    if (!account) continue;
    svm.setAccount({
      address: account.address,
      data: account.data,
      executable: account.executable,
      lamports: lamports(account.lamports),
      programAddress: account.owner,
      space: BigInt(account.data.length),
    });
  }
  for (const program of programs) {
    if (program.loader) svm.addProgramWithLoader(program.programId, program.elf, program.loader);
    else svm.addProgram(program.programId, program.elf);
  }
  svm.warpToSlot(clock.slot);
  svm.setClock(new Clock(clock.slot, clock.epochStartTimestamp, clock.epoch, clock.leaderScheduleEpoch, clock.unixTimestamp));

  const result = svm.simulateTransaction(getTransactionDecoder().decode(wire));
  if (result instanceof FailedTransactionMetadata) {
    const meta = result.meta();
    return {
      err: liteSvmErrorToRpc(result.err()),
      logs: meta.logs(),
      inner: innerInstructions(meta),
      unitsConsumed: meta.computeUnitsConsumed(),
      post: new Map(),
    };
  }
  const meta = result.meta();
  const post = new Map<Address, AccountState>(
    result.postAccounts().map((a) => [a.address, { lamports: a.lamports, owner: a.programAddress, data: new Uint8Array(a.data) }]),
  );
  return { err: null, logs: meta.logs(), inner: innerInstructions(meta), unitsConsumed: meta.computeUnitsConsumed(), post };
}

function innerInstructions(meta: TransactionMetadata): InnerInstruction[][] {
  return meta.innerInstructions().map((list) =>
    list.map((inner) => {
      const ix = inner.instruction();
      return { programIdIndex: ix.programIdIndex(), accounts: [...ix.accounts()], data: new Uint8Array(ix.data()), stackHeight: inner.stackHeight() };
    }),
  );
}
