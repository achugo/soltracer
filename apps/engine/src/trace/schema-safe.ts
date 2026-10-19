import { accountDiffSchema, traceSchema, type AccountDiff, type AccountSide, type Trace } from "@soltracer/shared/trace";

/** Most characters of decoded output (JSON) kept per trace, and across all account diffs. */
export const MAX_DECODED_OUTPUT_CHARS = 2 * 1024 * 1024;

const decodedSize = (values: readonly unknown[]) => values.reduce<number>((n, v) => n + (v ? JSON.stringify(v).length : 0), 0);

/**
 * IDLs come from the chain, so a program's author controls what decoding produces. If the decoded
 * parts fall outside the shared contract, or are too large in total, drop them (render raw) rather
 * than fail the run.
 */
export function withoutInvalidDecoding(trace: Trace): Trace {
  const size = decodedSize(trace.nodes.map((n) => n.instruction?.decoded));
  if (size <= MAX_DECODED_OUTPUT_CHARS && traceSchema.safeParse(trace).success) return trace;
  return {
    ...trace,
    nodes: trace.nodes.map((n) => (n.instruction ? { ...n, instruction: { ...n.instruction, decoded: null } } : n)),
  };
}

const raw = (side: AccountSide | null): AccountSide | null => (side ? { ...side, decoded: null } : null);

/** Same for account diffs: per account for the contract, all of them for the size. */
export function diffsWithoutInvalidDecoding(diffs: readonly AccountDiff[]): AccountDiff[] {
  const strip = (d: AccountDiff): AccountDiff => ({ ...d, before: raw(d.before), after: raw(d.after) });
  const valid = diffs.map((d) => (accountDiffSchema.safeParse(d).success ? d : strip(d)));
  const size = decodedSize(valid.flatMap((d) => [d.before?.decoded, d.after?.decoded]));
  return size <= MAX_DECODED_OUTPUT_CHARS ? valid : valid.map(strip);
}
