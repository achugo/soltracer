import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { decodedInstructionSchema } from "@soltracer/shared/trace";
import { describe, expect, it } from "vitest";
import { decodeIdlAccount, decodeIdlInstruction, normalizeIdl, normalizedIdlSchema } from "../../src/decode/idl-full.ts";
import { IdlParseError } from "../../src/decode/idl.ts";
import { decodeTransactionInput } from "../../src/tx/decode.ts";
import { resolveAccounts } from "../../src/tx/lookup-tables.ts";
import { loadOnChain, tablesFromMeta, type OnChainFixtureName } from "../helpers/sandbox-fixtures.ts";

const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

function jupiterIdlJson(): unknown {
  const fx = JSON.parse(readFileSync(new URL("../fixtures/idl/jupiter-v6.idl.json", import.meta.url), "utf8")) as {
    rpc: { response: { result: { value: { data: [string, string] } } } }[];
  };
  const data = Buffer.from(fx.rpc[0]?.response.result.value.data[0] ?? "", "base64");
  return JSON.parse(inflateSync(data.subarray(44, 44 + data.readUInt32LE(40))).toString("utf8"));
}
const jupiter = normalizeIdl(jupiterIdlJson());

/** Top-level Jupiter instructions of a recorded (v0) transaction. */
function jupiterInstructions(name: OnChainFixtureName) {
  const fx = loadOnChain(name);
  const decoded = decodeTransactionInput(fx.transaction[0]);
  if (!decoded.ok) throw new Error(decoded.error.message);
  const accounts = resolveAccounts(decoded.tx, tablesFromMeta(decoded.tx.lookups, fx));
  const compiled = decoded.tx.compiled;
  if (!("instructions" in compiled)) throw new Error(`${name} is not legacy/v0`);
  return compiled.instructions
    .filter((ix) => accounts[ix.programAddressIndex]?.address === JUP)
    .map((ix) => ({ data: Uint8Array.from(ix.data ?? []), accountCount: ix.accountIndices?.length ?? 0 }));
}

const sighash = (preimage: string) => [...createHash("sha256").update(preimage).digest().subarray(0, 8)];

describe("normalizeIdl", () => {
  it("reads Jupiter's on-chain IDL (current Anchor format)", () => {
    expect(jupiter.instructions).toHaveLength(19);
    const route = jupiter.instructions.find((i) => i.name === "shared_accounts_route");
    expect(route?.discriminator).toEqual([193, 32, 155, 51, 65, 214, 156, 129]);
    expect(route?.accounts.slice(0, 3)).toEqual(["token_program", "program_authority", "user_transfer_authority"]);
    expect(jupiter.accounts).toEqual([{ name: "TokenLedger", discriminator: [156, 247, 9, 188, 54, 108, 85, 77] }]);
    expect(normalizedIdlSchema.parse(JSON.parse(JSON.stringify(jupiter)))).toEqual(jupiter); // survives a jsonb round trip
  });

  it("rejects IDL JSON nested deeper than any real IDL, without recursing", () => {
    let deep: unknown = "u8";
    for (let i = 0; i < 200_000; i++) deep = [deep];
    expect(() => normalizeIdl({ instructions: [{ name: "x", discriminator: [1], args: [{ name: "a", type: deep }] }] })).toThrow(IdlParseError);
  });

  it("the longest matching discriminator wins", () => {
    const idl = normalizeIdl({
      instructions: [
        { name: "short", discriminator: [1], args: [] },
        { name: "long", discriminator: [1, 2], args: [] },
      ],
    });
    expect(decodeIdlInstruction(idl, Uint8Array.from([1, 2]), 0)?.name).toBe("long");
    expect(decodeIdlInstruction(idl, Uint8Array.from([1]), 0)?.name).toBe("short");
  });

  it("rejects JSON that isn't an IDL", () => {
    expect(() => normalizeIdl({ instructions: [{ name: "", discriminator: [1] }] })).toThrow(IdlParseError);
    expect(() => normalizeIdl({ hello: "world" })).toThrow(IdlParseError);
    expect(() => normalizeIdl({ instructions: [{ name: 5 }] })).toThrow(IdlParseError);
    expect(() => normalizeIdl({ instructions: [{ name: "x", discriminator: [] }] })).toThrow(IdlParseError);
  });
});

describe("decodeIdlInstruction on mainnet Jupiter swaps", () => {
  it.each(["jupiter-slippage-6001", "jupiter-swap-alt", "jupiter-swap-fresh", "jupiter-usdc-input"] as const)(
    "%s: decodes every byte of the route arguments",
    (name) => {
      const ixs = jupiterInstructions(name);
      expect(ixs.length).toBeGreaterThan(0);
      for (const ix of ixs) {
        const decoded = decodeIdlInstruction(jupiter, ix.data, ix.accountCount);
        expect(decoded, name).not.toBeNull();
        expect(decodedInstructionSchema.safeParse(decoded).error).toBeUndefined();
        expect(decoded?.name).toMatch(/route/);
        expect(decoded?.args.in_amount ?? decoded?.args.out_amount).toMatch(/^\d+$/);
        expect(decoded?.accountNames).toHaveLength(ix.accountCount);
      }
    },
  );

  it("jupiter-slippage-6001: a shared-accounts route through Whirlpool, with named accounts", () => {
    const [ix] = jupiterInstructions("jupiter-slippage-6001");
    if (!ix) throw new Error("no Jupiter instruction");
    const decoded = decodeIdlInstruction(jupiter, ix.data, ix.accountCount);
    expect(decoded?.name).toBe("shared_accounts_route");
    const plan = decoded?.args.route_plan as { swap: unknown; percent: number; input_index: number }[];
    expect(plan.some((step) => JSON.stringify(step.swap).includes("Whirlpool"))).toBe(true);
    expect(plan.reduce((sum, s) => sum + (s.input_index === 0 ? s.percent : 0), 0)).toBe(100);
    expect(typeof decoded?.args.slippage_bps).toBe("number");
    expect(decoded?.accountNames.slice(0, 2)).toEqual(["token_program", "program_authority"]);
    expect(decoded?.accountNames.slice(13).every((n) => n === null)).toBe(true); // remaining accounts: the hops'
  });

  it("returns null (render raw) for an unknown discriminator, short data or trailing bytes", () => {
    const [ix] = jupiterInstructions("jupiter-slippage-6001");
    if (!ix) throw new Error("no Jupiter instruction");
    expect(decodeIdlInstruction(jupiter, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]), 0)).toBeNull();
    expect(decodeIdlInstruction(jupiter, ix.data.subarray(0, ix.data.length - 1), ix.accountCount)).toBeNull();
    expect(decodeIdlInstruction(jupiter, Uint8Array.from([...ix.data, 0]), ix.accountCount)).toBeNull();
    expect(decodeIdlInstruction(jupiter, new Uint8Array(0), 0)).toBeNull();
  });

  it("never throws on random data behind a real discriminator", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) & 0xff;
    for (const instruction of jupiter.instructions) {
      for (let i = 0; i < 50; i++) {
        const data = Uint8Array.from([...instruction.discriminator, ...Array.from({ length: i * 3 }, rand)]);
        expect(() => decodeIdlInstruction(jupiter, data, 4)).not.toThrow();
      }
    }
  });
});

describe("decodeIdlAccount", () => {
  it("decodes an account by its discriminator (Jupiter's TokenLedger)", () => {
    const amount = new Uint8Array(8);
    new DataView(amount.buffer).setBigUint64(0, 5_000_000_000n, true);
    const data = Uint8Array.from([156, 247, 9, 188, 54, 108, 85, 77, ...new Uint8Array(32).fill(1), ...amount]);
    expect(decodeIdlAccount(jupiter, data)).toEqual({
      type: "TokenLedger",
      fields: { token_account: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", amount: "5000000000" },
    });
  });

  it("returns null for other data, and allows trailing bytes (accounts are often padded)", () => {
    expect(decodeIdlAccount(jupiter, new Uint8Array(48))).toBeNull();
    expect(decodeIdlAccount(jupiter, Uint8Array.from([156, 247, 9, 188, 54, 108, 85, 77, 1]))).toBeNull();
    const padded = Uint8Array.from([156, 247, 9, 188, 54, 108, 85, 77, ...new Uint8Array(40), ...new Uint8Array(100)]);
    expect(decodeIdlAccount(jupiter, padded)?.type).toBe("TokenLedger");
  });
});

describe("legacy Anchor IDLs", () => {
  const legacy = normalizeIdl({
    version: "0.1.0",
    name: "legacy",
    instructions: [
      {
        name: "depositV2",
        accounts: [
          { name: "user", isMut: true, isSigner: true },
          { name: "pool", accounts: [{ name: "state", isMut: true, isSigner: false }, { name: "vault", isMut: true, isSigner: false }] },
        ],
        args: [
          { name: "amount", type: "u64" },
          { name: "owner", type: "publicKey" },
          { name: "side", type: { defined: "Side" } },
        ],
      },
    ],
    accounts: [{ name: "PoolState", type: { kind: "struct", fields: [{ name: "authority", type: "publicKey" }, { name: "side", type: { defined: "Side" } }] } }],
    types: [{ name: "Side", type: { kind: "enum", variants: [{ name: "Bid" }, { name: "Ask" }] } }],
  });

  it("derives instruction discriminators from the snake_case name, and flattens account groups", () => {
    expect(legacy.instructions[0]?.discriminator).toEqual(sighash("global:deposit_v2"));
    const amount = new Uint8Array(8);
    new DataView(amount.buffer).setBigUint64(0, 42n, true);
    const data = Uint8Array.from([...sighash("global:deposit_v2"), ...amount, ...new Uint8Array(32), 1]);
    expect(decodeIdlInstruction(legacy, data, 4)).toEqual({
      name: "depositV2",
      args: { amount: "42", owner: "11111111111111111111111111111111", side: "Ask" },
      accountNames: ["user", "pool.state", "pool.vault", null],
    });
  });

  it("derives account discriminators from the account name and decodes inline account types", () => {
    const data = Uint8Array.from([...sighash("account:PoolState"), ...new Uint8Array(32), 0]);
    expect(decodeIdlAccount(legacy, data)).toEqual({ type: "PoolState", fields: { authority: "11111111111111111111111111111111", side: "Bid" } });
  });

  it("an account type the IDL never defines decodes to null", () => {
    const idl = normalizeIdl({ instructions: [], accounts: [{ name: "Ghost", discriminator: [1, 2, 3, 4, 5, 6, 7, 8] }] });
    expect(decodeIdlAccount(idl, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 0]))).toBeNull();
  });
});

describe("account names are capped to the shared schema", () => {
  it("never lists more names than accounts passed", () => {
    const idl = normalizeIdl({ instructions: [{ name: "a", discriminator: [1], accounts: [{ name: "x" }, { name: "y" }], args: [] }] });
    expect(decodeIdlInstruction(idl, Uint8Array.from([1]), 1)?.accountNames).toEqual(["x"]);
    expect(decodeIdlInstruction(idl, Uint8Array.from([1]), 300)?.accountNames).toHaveLength(256);
  });
});
