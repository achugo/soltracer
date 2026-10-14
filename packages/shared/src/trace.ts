import { z } from "zod";
import { u64Schema, txErrorSchema } from "./simulation.ts";
import { pubkeySchema } from "./solana.ts";

/** Most nodes in one trace. The runtime caps a transaction's instruction trace at 64; this leaves room. */
export const MAX_TRACE_NODES = 256;
/** Deepest CPI nesting accepted (the runtime allows 5; top-level instructions are depth 1). */
export const MAX_TRACE_DEPTH = 16;
/** Most log lines kept per node; the rest are counted in `logsDropped`. */
export const MAX_NODE_LOGS = 100;
/** Most bytes of instruction data carried per node (CPI data can reach 10 KiB). */
export const MAX_INSTRUCTION_DATA_BYTES = 10 * 1024;
/** Deepest nesting of a decoded value (instruction args, account fields). */
export const MAX_DECODED_DEPTH = 8;
/** Most accounts in one instruction, and in one run's account diffs. */
export const MAX_INSTRUCTION_ACCOUNTS = 256;
export const MAX_ACCOUNT_DIFFS = 256;
/** Longest log line kept (the runtime's whole log budget is 10 KB). */
export const MAX_LOG_LINE_CHARS = 10_000;
/** Runtime limit on a program's return data. */
export const MAX_RETURN_DATA_BYTES = 1024;
/** Most changed byte ranges listed per account. */
export const MAX_DIFF_RANGES = 64;
/** Most bytes shown on each side of a changed range; `length` is always the full length. */
export const MAX_RANGE_BYTES_SHOWN = 256;

const hex = (maxBytes: number) =>
  z.string().max(maxBytes * 2).regex(/^(?:[0-9a-f]{2})*$/, "Must be lowercase hex");
const base64 = (maxBytes: number) =>
  z
    .string()
    .max(Math.ceil(maxBytes / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "Must be base64");

function depthOf(value: unknown): number {
  if (Array.isArray(value)) return 1 + value.reduce<number>((m, v) => Math.max(m, depthOf(v)), 0);
  if (value !== null && typeof value === "object") {
    return 1 + Object.values(value).reduce<number>((m, v) => Math.max(m, depthOf(v)), 0);
  }
  return 0;
}

/** A decoded borsh value as JSON. Integers wider than 53 bits are decimal strings; pubkeys are base58. */
export const decodedValueSchema = z
  .json()
  .refine((v) => depthOf(v) <= MAX_DECODED_DEPTH, `Decoded values nest at most ${MAX_DECODED_DEPTH} levels`);

export const decodedInstructionSchema = z.object({
  /** Instruction name from the IDL. */
  name: z.string().min(1),
  args: z.record(z.string(), decodedValueSchema),
  /** IDL account name per instruction account, in order; null past the IDL's list (remaining accounts). */
  accountNames: z.array(z.string().nullable()).max(MAX_INSTRUCTION_ACCOUNTS),
});

export const traceInstructionSchema = z.object({
  data: hex(MAX_INSTRUCTION_DATA_BYTES),
  accounts: z.array(pubkeySchema).max(MAX_INSTRUCTION_ACCOUNTS),
  /** Null when no IDL is known for the program, or the data doesn't match it: render raw. */
  decoded: decodedInstructionSchema.nullable(),
});

export const traceNodeStatusSchema = z.enum([
  "success",
  "failed",
  /** Top-level instruction after the failure; it never ran. */
  "not-run",
  /** The logs stop before this node finished (truncated logs). */
  "incomplete",
]);

export const traceNodeSchema = z.object({
  /** Index in `trace.nodes`, in execution order (depth-first: a node's descendants follow it contiguously). */
  id: z.number().int().min(0),
  parent: z.number().int().min(0).nullable(),
  depth: z.number().int().min(1).max(MAX_TRACE_DEPTH),
  /** The top-level instruction this node belongs to. */
  instructionIndex: z.number().int().min(0),
  programId: pubkeySchema,
  status: traceNodeStatusSchema,
  /** From "consumed N of M"; null when the program logs none (builtins) or never finished. */
  consumed: z.number().int().min(0).nullable(),
  budget: z.number().int().min(0).nullable(),
  /** `consumed` minus the children's; null when any of those is unknown. */
  selfConsumed: z.number().int().min(0).nullable(),
  /** Decoded error, on the failing node only (the deepest failed node; its ancestors fail with it). */
  error: txErrorSchema.nullable(),
  /** This node's own log lines (not its children's). */
  logs: z.array(z.string().max(MAX_LOG_LINE_CHARS)).max(MAX_NODE_LOGS),
  logsDropped: z.number().int().min(0),
  returnData: z.object({ programId: pubkeySchema, dataBase64: base64(MAX_RETURN_DATA_BYTES) }).nullable(),
  /** Null when the instruction's data isn't known (rpc runs only see top-level data). */
  instruction: traceInstructionSchema.nullable(),
});

export const traceSchema = z
  .object({
    nodes: z.array(traceNodeSchema).max(MAX_TRACE_NODES),
    failingNodeId: z.number().int().min(0).nullable(),
    /** False when the logs were truncated, so the tree may be missing nodes. */
    complete: z.boolean(),
  })
  .superRefine((t, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    // Depth-first order: a node's parent is on the current ancestor stack, so subtrees are contiguous.
    const stack: number[] = [];
    let lastTopLevel = -1;
    t.nodes.forEach((n, i) => {
      if (n.id !== i) issue(["nodes", i], "id must equal the node's index");
      if (n.parent === null) {
        stack.length = 0;
        if (n.depth !== 1) issue(["nodes", i], "top-level nodes have depth 1");
        if (n.instructionIndex <= lastTopLevel) issue(["nodes", i], "top-level instructionIndex must increase");
        lastTopLevel = n.instructionIndex;
      } else {
        const at = stack.lastIndexOf(n.parent);
        const parent = t.nodes[n.parent];
        if (at === -1 || !parent) {
          issue(["nodes", i], "parent must be an ancestor still open in execution order");
        } else {
          stack.length = at + 1;
          if (n.depth !== parent.depth + 1) issue(["nodes", i], "depth must be the parent's depth + 1");
          if (n.instructionIndex !== parent.instructionIndex) issue(["nodes", i], "instructionIndex must match the parent's");
        }
      }
      stack.push(i);
      if (n.error !== null && i !== t.failingNodeId) issue(["nodes", i, "error"], "Only the failing node carries an error");
    });
    if (t.nodes.some((n) => n.status === "incomplete") && t.complete) {
      issue(["complete"], "A trace with incomplete nodes is not complete");
    }
    if (t.failingNodeId === null) {
      if (t.nodes.some((n) => n.status === "failed")) issue(["failingNodeId"], "Required when a node failed");
      return;
    }
    const failingId = t.failingNodeId;
    if (t.nodes[failingId]?.status !== "failed") {
      issue(["failingNodeId"], "Must point to a failed node");
    } else if (t.nodes.some((n) => n.parent === failingId && n.status === "failed")) {
      issue(["failingNodeId"], "Must point to the deepest failed node");
    }
  });

export const decodedAccountSchema = z.object({
  /** Where the field names came from. */
  layout: z.enum(["system", "token", "token-2022", "mint", "idl"]),
  /** Account type, e.g. "TokenAccount" or the IDL account name. */
  type: z.string().min(1),
  fields: z.record(z.string(), decodedValueSchema),
});

export const accountSideSchema = z.object({
  lamports: u64Schema,
  owner: pubkeySchema,
  dataLength: z.number().int().min(0),
  /** Null when no known layout or IDL account type matches: see `changedRanges`. */
  decoded: decodedAccountSchema.nullable(),
});

export const changedRangeSchema = z
  .object({
    offset: z.number().int().min(0),
    /** Full length of the change; `before`/`after` show at most MAX_RANGE_BYTES_SHOWN bytes. */
    length: z.number().int().min(1),
    /** Shorter than shown (or "") where that side has no bytes there: a created, closed or resized account. */
    before: hex(MAX_RANGE_BYTES_SHOWN),
    after: hex(MAX_RANGE_BYTES_SHOWN),
  })
  .refine(
    (r) => Math.max(r.before.length, r.after.length) <= Math.min(r.length, MAX_RANGE_BYTES_SHOWN) * 2,
    "Shown bytes can't exceed the range's length",
  );

export const accountDiffSchema = z
  .object({
    address: pubkeySchema,
    /** Null when the account didn't exist before the run. */
    before: accountSideSchema.nullable(),
    /** Null when the run closed the account. */
    after: accountSideSchema.nullable(),
    changedRanges: z.array(changedRangeSchema).max(MAX_DIFF_RANGES),
    /** True when more ranges changed than are listed. */
    rangesTruncated: z.boolean(),
  })
  .refine((d) => d.before !== null || d.after !== null, "An account diff needs a before or an after");

export type DecodedValue = z.infer<typeof decodedValueSchema>;
export type DecodedInstruction = z.infer<typeof decodedInstructionSchema>;
export type TraceInstruction = z.infer<typeof traceInstructionSchema>;
export type TraceNodeStatus = z.infer<typeof traceNodeStatusSchema>;
export type TraceNode = z.infer<typeof traceNodeSchema>;
export type Trace = z.infer<typeof traceSchema>;
export type DecodedAccount = z.infer<typeof decodedAccountSchema>;
export type AccountSide = z.infer<typeof accountSideSchema>;
export type ChangedRange = z.infer<typeof changedRangeSchema>;
export type AccountDiff = z.infer<typeof accountDiffSchema>;
