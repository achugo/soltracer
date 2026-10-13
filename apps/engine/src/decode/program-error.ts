import type { TxError } from "@soltracer/shared/simulation";
import type { Address } from "@solana/kit";
import { z } from "zod";
import { builtinCustomError, humanize } from "./builtin-errors.ts";
import type { IdlErrorInfo } from "./idl.ts";

export interface FailureSite {
  instructionIndex: number | null;
  /** Program of the failing top-level instruction. */
  programId: Address | null;
  /** Program that raised the error, from the first "Program X failed" log (may be a CPI callee). */
  failingProgramId: Address | null;
  customCode: number | null;
}

const instructionErrorSchema = z.object({
  InstructionError: z.tuple([z.union([z.number(), z.bigint()]).transform(Number), z.unknown()]),
});
const customSchema = z.object({ Custom: z.union([z.number(), z.bigint()]).transform(Number) });

/** Where a transaction failed: which instruction, which program, which custom code. */
export function locateFailure(err: unknown, logs: readonly string[], instructionPrograms: readonly Address[]): FailureSite {
  const ix = instructionErrorSchema.safeParse(err);
  if (!ix.success) return { instructionIndex: null, programId: null, failingProgramId: null, customCode: null };

  const [index, inner] = ix.data.InstructionError;
  const custom = customSchema.safeParse(inner);
  // The error propagates up the CPI stack and every caller logs "failed"; the first line is the origin.
  const failedLine = logs.find((l) => /^Program \w+ failed: /.test(l));
  const failing = failedLine ? (/^Program (\w+) failed: /.exec(failedLine)?.[1] ?? null) : null;
  const programId = instructionPrograms[index] ?? null;
  return {
    instructionIndex: index,
    programId,
    failingProgramId: (failing as Address | null) ?? programId,
    customCode: custom.success ? custom.data.Custom : null,
  };
}

/** Deep copy with bigints as numbers (or strings beyond 2^53), so the result serializes. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

/** Name and message for a transaction-level or non-custom instruction error. */
function describeVariant(value: unknown): { name: string; message: string } {
  if (typeof value === "string") return { name: value, message: humanize(value) };
  const entry = typeof value === "object" && value !== null ? Object.entries(value)[0] : undefined;
  if (!entry) return { name: "Unknown", message: "Unknown error" };
  const [name, payload] = entry;
  const accountIndex = z.object({ account_index: z.union([z.number(), z.bigint()]) }).safeParse(payload);
  const suffix = accountIndex.success
    ? ` (account index ${accountIndex.data.account_index})`
    : typeof payload === "string" || typeof payload === "number" || typeof payload === "bigint"
      ? `: ${payload}`
      : "";
  return { name, message: `${humanize(name)}${suffix}` };
}

/**
 * Human-readable error. Custom codes resolve from the failing program's IDL first, then built-in
 * tables (System, SPL Token, Token-2022, Anchor framework for Anchor programs), then the raw code.
 */
export function describeFailure(
  err: unknown,
  site: FailureSite,
  idl: { program: Address; errors: ReadonlyMap<number, IdlErrorInfo> } | null,
): TxError {
  const base = { ...site, raw: jsonSafe(err) };
  const { customCode, failingProgramId } = site;
  // An IDL only describes its own program's codes; ignore it if the error came from elsewhere.
  const idlErrors = idl && idl.program === failingProgramId ? idl.errors : null;

  if (customCode !== null) {
    const fromIdl = idlErrors?.get(customCode);
    if (fromIdl) return { ...base, code: customCode, name: fromIdl.name, message: fromIdl.message, source: "idl" };
    const builtin = failingProgramId ? builtinCustomError(failingProgramId, customCode, idlErrors !== null) : null;
    if (builtin) return { ...base, code: customCode, name: builtin, message: humanize(builtin), source: "builtin" };
    const hex = `0x${customCode.toString(16)}`;
    return {
      ...base,
      code: customCode,
      name: null,
      message: `Custom program error ${customCode} (${hex})${failingProgramId ? ` from ${failingProgramId}` : ""}`,
      source: "raw",
    };
  }

  const ix = instructionErrorSchema.safeParse(err);
  const variant = describeVariant(ix.success ? ix.data.InstructionError[1] : err);
  return { ...base, code: null, name: variant.name, message: variant.message, source: "builtin" };
}
