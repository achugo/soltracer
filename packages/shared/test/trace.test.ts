import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  accountDiffSchema,
  MAX_DECODED_DEPTH,
  MAX_INSTRUCTION_ACCOUNTS,
  MAX_LOG_LINE_CHARS,
  MAX_DIFF_RANGES,
  MAX_NODE_LOGS,
  MAX_RANGE_BYTES_SHOWN,
  traceSchema,
  type AccountDiff,
  type Trace,
  type TraceNode,
} from "../src/trace.ts";

const key = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));
// No Node or DOM lib in this package, so no structuredClone; the fixtures are plain JSON.
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function defined<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("fixture is missing a value");
  return v;
}
const nodeAt = (t: Trace, i: number) => defined(t.nodes[i]);
const ix = (t: Trace) => defined(nodeAt(t, 0).instruction);

function node(overrides: Partial<TraceNode> & Pick<TraceNode, "id">): TraceNode {
  return {
    parent: null,
    depth: 1,
    instructionIndex: 0,
    programId: key(1),
    status: "success",
    consumed: 1000,
    budget: 200_000,
    selfConsumed: 1000,
    error: null,
    logs: [],
    logsDropped: 0,
    returnData: null,
    instruction: null,
    ...overrides,
  };
}

const failedRoute: Trace = {
  nodes: [
    node({ id: 0, status: "failed", consumed: 50_000, selfConsumed: 40_000, instruction: {
      data: "e517cb977ae3ad2a",
      accounts: [key(2), key(3)],
      decoded: { name: "route", args: { inAmount: "1000000", slippageBps: 50, routePlan: [{ swap: { kind: "Whirlpool" } }] }, accountNames: ["tokenProgram", null] },
    } }),
    node({ id: 1, parent: 0, depth: 2, programId: key(4), consumed: 10_000, selfConsumed: 10_000 }),
    node({
      id: 2,
      parent: 0,
      depth: 2,
      programId: key(5),
      status: "failed",
      consumed: null,
      selfConsumed: null,
      error: { instructionIndex: 0, programId: key(1), failingProgramId: key(5), code: 6001, name: "SlippageToleranceExceeded", message: "Slippage tolerance exceeded", source: "idl", raw: { InstructionError: [0, { Custom: 6001 }] } },
      logs: ["Program log: AnchorError occurred"],
    }),
    node({ id: 3, instructionIndex: 1, status: "not-run", consumed: null, budget: null, selfConsumed: null }),
  ],
  failingNodeId: 2,
  complete: true,
};

describe("traceSchema", () => {
  it("accepts a failed multi-hop route with a decoded instruction", () => {
    expect(traceSchema.parse(failedRoute)).toEqual(failedRoute);
  });

  it("accepts a later sibling subtree and return data", () => {
    const t = clone(failedRoute);
    t.nodes.splice(2, 0, node({ id: 2, parent: 1, depth: 3, returnData: { programId: key(4), dataBase64: "AQID" } }));
    t.nodes = t.nodes.map((n, i) => ({ ...n, id: i }));
    t.failingNodeId = 3;
    expect(traceSchema.safeParse(t).success).toBe(true);
  });

  it("accepts an empty trace (no logs at all)", () => {
    expect(traceSchema.safeParse({ nodes: [], failingNodeId: null, complete: false }).success).toBe(true);
  });

  it.each([
    ["an id that isn't the index", (t: Trace) => { t.nodes[1] = { ...nodeAt(t, 1), id: 7 }; }],
    ["a parent after the node", (t: Trace) => { t.nodes[1] = { ...nodeAt(t, 1), parent: 2 }; }],
    ["a depth that skips a level", (t: Trace) => { t.nodes[1] = { ...nodeAt(t, 1), depth: 3 }; }],
    ["a child of another top-level instruction", (t: Trace) => { t.nodes[1] = { ...nodeAt(t, 1), instructionIndex: 1 }; }],
    ["a top-level node deeper than 1", (t: Trace) => { t.nodes[3] = { ...nodeAt(t, 3), depth: 2 }; }],
    ["a failing id on a successful node", (t: Trace) => { t.failingNodeId = 1; }],
    ["a failing id past the last node", (t: Trace) => { t.failingNodeId = 99; }],
    ["a failing id that isn't the deepest failure", (t: Trace) => {
      t.failingNodeId = 0;
      t.nodes[0] = { ...nodeAt(t, 0), error: nodeAt(t, 2).error };
      t.nodes[2] = { ...nodeAt(t, 2), error: null };
    }],
    ["a failed node without a failing id", (t: Trace) => { t.failingNodeId = null; t.nodes[2] = { ...nodeAt(t, 2), error: null }; }],
    ["a child that resumes a closed subtree", (t: Trace) => {
      // 0, 1(p0), 2(p1), 3(p0), 4(p1): node 1's subtree closed when node 3 started.
      t.nodes = [
        { ...nodeAt(t, 0), status: "success" },
        nodeAt(t, 1),
        node({ id: 2, parent: 1, depth: 3 }),
        node({ id: 3, parent: 0, depth: 2 }),
        node({ id: 4, parent: 1, depth: 3 }),
      ];
      t.failingNodeId = null;
    }],
    ["top-level instructions out of order", (t: Trace) => { t.nodes[3] = { ...nodeAt(t, 3), instructionIndex: 0 }; }],
    ["incomplete nodes in a complete trace", (t: Trace) => { t.nodes[3] = { ...nodeAt(t, 3), status: "incomplete" }; }],
    ["an over-long log line", (t: Trace) => { t.nodes[1] = { ...nodeAt(t, 1), logs: ["x".repeat(MAX_LOG_LINE_CHARS + 1)] }; }],
    ["return data that isn't base64", (t: Trace) => { t.nodes[1] = { ...nodeAt(t, 1), returnData: { programId: key(4), dataBase64: "not base64!" } }; }],
    ["too many instruction accounts", (t: Trace) => {
      t.nodes[0] = { ...nodeAt(t, 0), instruction: { ...ix(t), accounts: Array<string>(MAX_INSTRUCTION_ACCOUNTS + 1).fill(key(2)) } };
    }],
    ["an error on a node that isn't the failing one", (t: Trace) => { t.nodes[0] = { ...nodeAt(t, 0), error: nodeAt(t, 2).error }; }],
    ["too many log lines", (t: Trace) => { t.nodes[1] = { ...nodeAt(t, 1), logs: Array<string>(MAX_NODE_LOGS + 1).fill("x") }; }],
    ["uppercase instruction hex", (t: Trace) => { t.nodes[0] = { ...nodeAt(t, 0), instruction: { ...ix(t), data: "E5" } }; }],
    ["a bigint arg", (t: Trace) => {
      t.nodes[0] = { ...nodeAt(t, 0), instruction: { ...ix(t), decoded: { name: "route", args: { inAmount: 1n as unknown as string }, accountNames: [] } } };
    }],
  ])("rejects %s", (_, mutate) => {
    const t = clone(failedRoute);
    mutate(t);
    expect(traceSchema.safeParse(t).success).toBe(false);
  });

  it(`caps decoded values at ${MAX_DECODED_DEPTH} levels`, () => {
    const nest = (n: number): unknown => (n === 0 ? 1 : [nest(n - 1)]);
    const withArgs = (v: unknown) => {
      const t = clone(failedRoute);
      t.nodes[0] = { ...nodeAt(t, 0), instruction: { ...ix(t), decoded: { name: "route", args: { v } as never, accountNames: [] } } };
      return traceSchema.safeParse(t).success;
    };
    expect(withArgs(nest(MAX_DECODED_DEPTH))).toBe(true); // the cap applies to each arg's value
    expect(withArgs(nest(MAX_DECODED_DEPTH + 1))).toBe(false);
  });
});

const tokenDiff: AccountDiff = {
  address: key(6),
  before: {
    lamports: "2039280",
    owner: key(7),
    dataLength: 165,
    decoded: { layout: "token", type: "TokenAccount", fields: { mint: key(8), owner: key(9), amount: "18446744073709551615", state: "initialized" } },
  },
  after: {
    lamports: "2039280",
    owner: key(7),
    dataLength: 165,
    decoded: { layout: "token", type: "TokenAccount", fields: { mint: key(8), owner: key(9), amount: "0", state: "initialized" } },
  },
  changedRanges: [{ offset: 64, length: 8, before: "ffffffffffffffff", after: "0000000000000000" }],
  rangesTruncated: false,
};

describe("accountDiffSchema", () => {
  it("accepts a token account diff with u64 amounts as strings", () => {
    expect(accountDiffSchema.parse(tokenDiff)).toEqual(tokenDiff);
  });

  it("accepts a newly created account and a closed one", () => {
    expect(accountDiffSchema.safeParse({ ...tokenDiff, before: null }).success).toBe(true);
    expect(accountDiffSchema.safeParse({ ...tokenDiff, after: null }).success).toBe(true);
  });

  it("caps ranges and the bytes shown per range", () => {
    const range = defined(tokenDiff.changedRanges[0]);
    expect(accountDiffSchema.safeParse({ ...tokenDiff, changedRanges: Array(MAX_DIFF_RANGES + 1).fill(range) }).success).toBe(false);
    const big = "ab".repeat(MAX_RANGE_BYTES_SHOWN + 1);
    expect(accountDiffSchema.safeParse({ ...tokenDiff, changedRanges: [{ ...range, length: 10_000, before: big }] }).success).toBe(false);
    const shown = "ab".repeat(MAX_RANGE_BYTES_SHOWN);
    expect(accountDiffSchema.safeParse({ ...tokenDiff, changedRanges: [{ ...range, length: 10_000, before: shown, after: shown }] }).success).toBe(true);
  });

  it("rejects a diff with neither side, and shown bytes longer than the range", () => {
    expect(accountDiffSchema.safeParse({ ...tokenDiff, before: null, after: null }).success).toBe(false);
    const range = defined(tokenDiff.changedRanges[0]);
    expect(accountDiffSchema.safeParse({ ...tokenDiff, changedRanges: [{ ...range, length: 2 }] }).success).toBe(false);
    expect(accountDiffSchema.safeParse({ ...tokenDiff, changedRanges: [{ ...range, before: "" }] }).success).toBe(true);
  });

  it("rejects lamports as a number", () => {
    expect(accountDiffSchema.safeParse({ ...tokenDiff, before: { ...defined(tokenDiff.before), lamports: 2039280 } }).success).toBe(false);
  });
});
