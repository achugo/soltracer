import { accountDiffSchema, traceSchema, type AccountDiff, type AccountSide, type Trace } from "@soltracer/shared/trace";

/**
 * IDLs come from the chain, so a program's author controls what decoding produces. If the decoded
 * parts ever fall outside the shared contract, drop them (render raw) rather than fail the run.
 */
export function withoutInvalidDecoding(trace: Trace): Trace {
  if (traceSchema.safeParse(trace).success) return trace;
  return {
    ...trace,
    nodes: trace.nodes.map((n) => (n.instruction ? { ...n, instruction: { ...n.instruction, decoded: null } } : n)),
  };
}

const raw = (side: AccountSide | null): AccountSide | null => (side ? { ...side, decoded: null } : null);

/** Same for account diffs, per account. */
export function diffsWithoutInvalidDecoding(diffs: readonly AccountDiff[]): AccountDiff[] {
  return diffs.map((d) => (accountDiffSchema.safeParse(d).success ? d : { ...d, before: raw(d.before), after: raw(d.after) }));
}
