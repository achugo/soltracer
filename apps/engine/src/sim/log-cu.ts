import type { Address } from "@solana/kit";

const INVOKE = /^Program (\w+) invoke \[(\d+)\]$/;
const CONSUMED = /^Program (\w+) consumed (\d+) of \d+ compute units$/;
const DONE = /^Program (\w+) (success|failed: .*)$/;

/**
 * CU used by each top-level instruction, from its own "consumed N of M" line (CPI lines are
 * nested inside and already counted in their caller). Builtin programs log no such line, and
 * instructions after a failure never run: both are null.
 */
export function perInstructionUnits(
  logs: readonly string[],
  programs: readonly Address[],
): { index: number; programId: Address; unitsConsumed: number | null }[] {
  const units: (number | null)[] = programs.map(() => null);
  let index = -1;
  let depth = 0;
  for (const line of logs) {
    const invoke = INVOKE.exec(line);
    if (invoke) {
      depth = Number(invoke[2]);
      if (depth === 1) index += 1;
      continue;
    }
    const consumed = CONSUMED.exec(line);
    // Only credit the line to the instruction whose program it names (guards odd or truncated logs).
    if (consumed && depth === 1 && index >= 0 && index < units.length && consumed[1] === programs[index]) {
      units[index] = Number(consumed[2]);
      continue;
    }
    if (DONE.test(line)) depth = Math.max(0, depth - 1);
  }
  return programs.map((programId, i) => ({ index: i, programId, unitsConsumed: units[i] ?? null }));
}
