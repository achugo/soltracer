import type { Address } from "@solana/kit";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./token-account.ts";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;

/** solana_program::system_instruction::SystemError */
const SYSTEM_ERRORS = [
  "AccountAlreadyInUse",
  "ResultWithNegativeLamports",
  "InvalidProgramId",
  "InvalidAccountDataLength",
  "MaxSeedLengthExceeded",
  "AddressWithSeedMismatch",
  "NonceNoRecentBlockhashes",
  "NonceBlockhashNotExpired",
  "NonceUnexpectedBlockhashValue",
];

/** spl_token::error::TokenError, shared by Token-2022 for codes 0-19. */
const TOKEN_ERRORS = [
  "NotRentExempt",
  "InsufficientFunds",
  "InvalidMint",
  "MintMismatch",
  "OwnerMismatch",
  "FixedSupply",
  "AlreadyInUse",
  "InvalidNumberOfProvidedSigners",
  "InvalidNumberOfRequiredSigners",
  "UninitializedState",
  "NativeNotSupported",
  "NonNativeHasBalance",
  "InvalidInstruction",
  "InvalidState",
  "Overflow",
  "AuthorityTypeNotSupported",
  "MintCannotFreeze",
  "AccountFrozen",
  "MintDecimalsMismatch",
  "NonNativeNotSupported",
];

/** anchor_lang::error::ErrorCode (framework errors, below 6000). */
const ANCHOR_ERRORS: Readonly<Record<number, string>> = {
  100: "InstructionMissing",
  101: "InstructionFallbackNotFound",
  102: "InstructionDidNotDeserialize",
  103: "InstructionDidNotSerialize",
  1000: "IdlInstructionStub",
  1001: "IdlInstructionInvalidProgram",
  1002: "IdlAccountNotEmpty",
  1500: "EventInstructionStub",
  2000: "ConstraintMut",
  2001: "ConstraintHasOne",
  2002: "ConstraintSigner",
  2003: "ConstraintRaw",
  2004: "ConstraintOwner",
  2005: "ConstraintRentExempt",
  2006: "ConstraintSeeds",
  2007: "ConstraintExecutable",
  2008: "ConstraintState",
  2009: "ConstraintAssociated",
  2010: "ConstraintAssociatedInit",
  2011: "ConstraintClose",
  2012: "ConstraintAddress",
  2013: "ConstraintZero",
  2014: "ConstraintTokenMint",
  2015: "ConstraintTokenOwner",
  2016: "ConstraintMintMintAuthority",
  2017: "ConstraintMintFreezeAuthority",
  2018: "ConstraintMintDecimals",
  2019: "ConstraintSpace",
  2020: "ConstraintAccountIsNone",
  2021: "ConstraintTokenTokenProgram",
  2022: "ConstraintMintTokenProgram",
  2023: "ConstraintAssociatedTokenTokenProgram",
  2500: "RequireViolated",
  2501: "RequireEqViolated",
  2502: "RequireKeysEqViolated",
  2503: "RequireNeqViolated",
  2504: "RequireKeysNeqViolated",
  2505: "RequireGtViolated",
  2506: "RequireGteViolated",
  3000: "AccountDiscriminatorAlreadySet",
  3001: "AccountDiscriminatorNotFound",
  3002: "AccountDiscriminatorMismatch",
  3003: "AccountDidNotDeserialize",
  3004: "AccountDidNotSerialize",
  3005: "AccountNotEnoughKeys",
  3006: "AccountNotMutable",
  3007: "AccountOwnedByWrongProgram",
  3008: "InvalidProgramId",
  3009: "InvalidProgramExecutable",
  3010: "AccountNotSigner",
  3011: "AccountNotSystemOwned",
  3012: "AccountNotInitialized",
  3013: "AccountNotProgramData",
  3014: "AccountNotAssociatedTokenAccount",
  3015: "AccountSysvarMismatch",
  3016: "AccountReallocExceedsLimit",
  3017: "AccountDuplicateReallocs",
  4000: "StateInvalidAddress",
  4100: "DeclaredProgramIdMismatch",
  4101: "TryingToInitPayerAsProgramAccount",
  4102: "InvalidNumericConversion",
  5000: "Deprecated",
};

/** "InsufficientFundsForRent" -> "Insufficient funds for rent" */
export function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A built-in name for a custom code, or null. Anchor names only apply to programs known to be Anchor. */
export function builtinCustomError(program: Address, code: number, isAnchorProgram: boolean): string | null {
  if (program === SYSTEM_PROGRAM) return SYSTEM_ERRORS[code] ?? null;
  if (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM) return TOKEN_ERRORS[code] ?? null;
  if (isAnchorProgram && code < 6000) return ANCHOR_ERRORS[code] ?? null;
  return null;
}
