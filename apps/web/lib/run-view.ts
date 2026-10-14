import { formatUnits, type Override, type SimulationResult } from "@soltracer/shared/simulation";
import { groupDigits, LAMPORTS_DECIMALS } from "./format.ts";

export interface InstructionCuRow {
  index: number;
  programId: string;
  /** Null when the program logged no "consumed" line (builtins, or the instruction never ran). */
  units: number | null;
  /** Share of the bar scale, 0 to 100. */
  percent: number;
}

export interface InstructionCuView {
  rows: InstructionCuRow[];
  /** Bar scale: the transaction total, or the reported sum if that is larger. */
  total: number;
  /** Units not attributed to any instruction (builtins, ComputeBudget, unreported). */
  unattributed: number;
}

/** Per-instruction CU table, sorted by instruction index, with bars relative to the total. */
export function instructionCuView(perInstruction: SimulationResult["perInstruction"], unitsConsumed: number): InstructionCuView {
  const reported = perInstruction.reduce((n, p) => n + (p.unitsConsumed ?? 0), 0);
  const total = Math.max(unitsConsumed, reported);
  const rows = [...perInstruction]
    .sort((a, b) => a.index - b.index)
    .map((p) => ({
      index: p.index,
      programId: p.programId,
      units: p.unitsConsumed,
      percent: p.unitsConsumed === null || total === 0 ? 0 : Math.min(100, (p.unitsConsumed / total) * 100),
    }));
  return { rows, total, unattributed: Math.max(0, unitsConsumed - reported) };
}

export interface OverrideSummary {
  kind: "SOL" | "Token" | "Data";
  /** The account the override targets: address for SOL and data, owner for tokens. */
  target: string;
  mint: string | null;
  /** Human-readable value: SOL amount, token amount (raw when decimals are unknown) or data size. */
  value: string;
  dataOwner: string | null;
}

function base64Bytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

/** Describes an applied override. Token amounts use the mint's decimals when the result reports them. */
export function summarizeOverride(o: Override, tokens: SimulationResult["balances"]["tokens"]): OverrideSummary {
  switch (o.kind) {
    case "sol":
      return {
        kind: "SOL",
        target: o.address,
        mint: null,
        value: `${formatUnits(o.lamports, LAMPORTS_DECIMALS)} SOL (${groupDigits(o.lamports)} lamports)`,
        dataOwner: null,
      };
    case "token": {
      const decimals = tokens.find((t) => t.mint === o.mint)?.decimals;
      return {
        kind: "Token",
        target: o.owner,
        mint: o.mint,
        value:
          decimals === undefined
            ? `${groupDigits(o.amount)} raw units`
            : `${formatUnits(o.amount, decimals)} (${groupDigits(o.amount)} raw units)`,
        dataOwner: null,
      };
    }
    case "data": {
      const bytes = base64Bytes(o.dataBase64);
      return {
        kind: "Data",
        target: o.address,
        mint: null,
        value: `${groupDigits(String(bytes))} byte${bytes === 1 ? "" : "s"}`,
        dataOwner: o.owner ?? null,
      };
    }
  }
}

export const ENGINE_LABEL: Record<SimulationResult["engine"], string> = { local: "Local (LiteSVM)", rpc: "RPC" };
