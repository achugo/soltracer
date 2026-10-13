import { describe, expect, it } from "vitest";
import { decodeTransactionInput } from "../../src/tx/decode.ts";
import { resolveAccounts } from "../../src/tx/lookup-tables.ts";
import { instructionPrograms } from "../../src/tx/programs.ts";
import { loadOnChain, tablesFromMeta, type SandboxFixtureName } from "../helpers/sandbox-fixtures.ts";

function programsOf(name: SandboxFixtureName): string[] {
  const fx = loadOnChain(name);
  const res = decodeTransactionInput(fx.transaction[0]);
  if (!res.ok) throw new Error(res.error.message);
  return instructionPrograms(res.tx, resolveAccounts(res.tx, tablesFromMeta(res.tx.lookups, fx)));
}

/** Programs invoked at depth 1, in order, from the on-chain logs. */
function topLevelFromLogs(name: SandboxFixtureName): string[] {
  return loadOnChain(name).meta.logMessages.flatMap((l) => /^Program (\w+) invoke \[1\]$/.exec(l)?.[1] ?? []);
}

describe("instructionPrograms", () => {
  it.each(["sol-transfer", "jupiter-swap-alt", "token-2022-transfer", "v1-transaction"] as const)(
    "matches the top-level invokes in the on-chain logs for %s",
    (name) => expect(programsOf(name)).toEqual(topLevelFromLogs(name)),
  );

  it("lists every instruction of a failed transaction, including ones that never ran", () => {
    const programs = programsOf("jupiter-slippage-6001");
    expect(programs).toHaveLength(7);
    expect(programs[3]).toBe("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  });
});
