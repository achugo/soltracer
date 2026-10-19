import { describe, expect, it } from "vitest";
import { decodedValueSchema, MAX_DECODED_DEPTH } from "@soltracer/shared/trace";
import { BorshError, decodeBorsh, MAX_DECODED_VALUES, type IdlTypeDefs } from "../../src/decode/borsh.ts";

const le = (n: bigint, bytes: number) => {
  const out = new Uint8Array(bytes);
  let v = BigInt.asUintN(bytes * 8, n);
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};
const cat = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const u32 = (n: number) => le(BigInt(n), 4);
const str = (s: string) => cat(u32(new TextEncoder().encode(s).length), new TextEncoder().encode(s));

/** Decodes and requires every byte to be used. */
function decode(type: unknown, data: Uint8Array, types: IdlTypeDefs = new Map()) {
  const { value, offset } = decodeBorsh(type, data, types);
  expect(offset).toBe(data.length);
  return value;
}

const types: IdlTypeDefs = new Map<string, unknown>([
  ["Point", { kind: "struct", fields: [{ name: "x", type: "i16" }, { name: "y", type: "i16" }] }],
  ["Pair", { kind: "struct", fields: ["u8", "bool"] }],
  ["Unit", { kind: "struct" }],
  [
    "Swap",
    {
      kind: "enum",
      variants: [{ name: "Saber" }, { name: "Crema", fields: [{ name: "a_to_b", type: "bool" }] }, { name: "Tuple", fields: ["u8", "u16"] }],
    },
  ],
  ["Amount", { kind: "type", alias: "u64" }],
  ["Loop", { kind: "type", alias: { defined: { name: "Loop" } } }],
  ["Nest", { kind: "struct", fields: [{ name: "inner", type: { option: { defined: { name: "Nest" } } } }] }],
  ["ZeroCopy", { kind: "struct", fields: [{ name: "a", type: "u64" }], serialization: "bytemuck" }],
  ["Generic", { kind: "struct", generics: [{ kind: "type", name: "T" }], fields: [{ name: "a", type: { generic: "T" } }] }],
]);

describe("decodeBorsh primitives", () => {
  it.each([
    ["u8", [255], 255],
    ["i8", [0x80], -128],
    ["u16", [0x34, 0x12], 0x1234],
    ["i16", [0xfe, 0xff], -2],
    ["u32", [1, 0, 0, 0x80], 0x80000001],
    ["i32", [0xff, 0xff, 0xff, 0xff], -1],
    ["bool", [1], true],
    ["bool", [0], false],
  ])("%s %j", (type, bytes, expected) => {
    expect(decode(type, Uint8Array.from(bytes))).toBe(expected);
  });

  it("wide integers are decimal strings", () => {
    expect(decode("u64", le(18_446_744_073_709_551_615n, 8))).toBe("18446744073709551615");
    expect(decode("i64", le(-5n, 8))).toBe("-5");
    expect(decode("u128", le(2n ** 127n + 3n, 16))).toBe((2n ** 127n + 3n).toString());
    expect(decode("i128", le(-(2n ** 100n), 16))).toBe((-(2n ** 100n)).toString());
    expect(decode("u256", le(2n ** 255n, 32))).toBe((2n ** 255n).toString());
    expect(decode("i256", le(-1n, 32))).toBe("-1");
  });

  it("floats are numbers, and non-finite floats are strings", () => {
    const f64 = new Uint8Array(8);
    new DataView(f64.buffer).setFloat64(0, 1.5, true);
    expect(decode("f64", f64)).toBe(1.5);
    const f32 = new Uint8Array(4);
    new DataView(f32.buffer).setFloat32(0, Number.NaN, true);
    expect(decode("f32", f32)).toBe("NaN");
  });

  it("strings, bytes and pubkeys (new and legacy spellings)", () => {
    expect(decode("string", str("héllo"))).toBe("héllo");
    expect(decode("bytes", cat(u32(3), [0xde, 0xad, 0x01]))).toBe("dead01");
    const key = new Uint8Array(32).fill(1);
    expect(decode("pubkey", key)).toBe("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi");
    expect(decode("publicKey", key)).toBe("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi");
  });
});

describe("decodeBorsh containers", () => {
  it("option and coption", () => {
    expect(decode({ option: "u8" }, Uint8Array.from([0]))).toBeNull();
    expect(decode({ option: "u8" }, Uint8Array.from([1, 7]))).toBe(7);
    expect(decode({ coption: "u8" }, cat(u32(0)))).toBeNull();
    expect(decode({ coption: "u8" }, cat(u32(1), [9]))).toBe(9);
  });

  it("vec and array", () => {
    expect(decode({ vec: "u16" }, cat(u32(2), [1, 0, 2, 0]))).toEqual([1, 2]);
    expect(decode({ array: ["u8", 3] }, Uint8Array.from([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it("a field named __proto__ is kept as data", () => {
    const defs: IdlTypeDefs = new Map([["Odd", { kind: "struct", fields: [{ name: "__proto__", type: "u8" }] }]]);
    const value = decode({ defined: { name: "Odd" } }, Uint8Array.from([7]), defs) as Record<string, unknown>;
    expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toBe(7);
  });

  it("defined structs (named, tuple, unit), enums and aliases, new and legacy spellings", () => {
    expect(decode({ defined: { name: "Point" } }, cat(le(-1n, 2), le(5n, 2)), types)).toEqual({ x: -1, y: 5 });
    expect(decode({ defined: "Point" }, cat(le(1n, 2), le(2n, 2)), types)).toEqual({ x: 1, y: 2 });
    expect(decode({ defined: { name: "Pair" } }, Uint8Array.from([4, 1]), types)).toEqual([4, true]);
    expect(decode({ defined: { name: "Unit" } }, new Uint8Array(0), types)).toEqual({});
    expect(decode({ defined: { name: "Swap" } }, Uint8Array.from([0]), types)).toBe("Saber");
    expect(decode({ defined: { name: "Swap" } }, Uint8Array.from([1, 1]), types)).toEqual({ Crema: { a_to_b: true } });
    expect(decode({ defined: { name: "Swap" } }, Uint8Array.from([2, 3, 4, 0]), types)).toEqual({ Tuple: [3, 4] });
    expect(decode({ defined: { name: "Amount" } }, le(10n, 8), types)).toBe("10");
  });
});

describe("decodeBorsh refuses what it can't decode faithfully", () => {
  const fails = (type: unknown, data: number[] | Uint8Array, defs = types) =>
    expect(() => decodeBorsh(type, Uint8Array.from(data), defs)).toThrow(BorshError);

  it("short data", () => {
    fails("u64", [1, 2, 3]);
    fails("string", [5, 0, 0, 0, 0x61]);
    fails({ vec: "u8" }, [3, 0, 0, 0, 1]);
  });

  it("invalid tags and values", () => {
    fails("bool", [2]);
    fails({ option: "u8" }, [2, 0]);
    fails({ coption: "u8" }, [2, 0, 0, 0, 0]);
    fails({ defined: { name: "Swap" } }, [9]);
    fails("string", [2, 0, 0, 0, 0xff, 0xfe]); // not UTF-8
  });

  it("unknown, generic, zero-copy and self-referencing types", () => {
    fails("u7", [0]);
    fails({ defined: { name: "Missing" } }, [0]);
    fails({ unknown: "u8" }, [0]);
    fails({ array: ["u8", { generic: "N" }] }, [0]);
    fails({ defined: { name: "Generic" } }, new Uint8Array(8));
    fails({ defined: { name: "ZeroCopy" } }, new Uint8Array(8));
    fails({ defined: { name: "Loop" } }, [0]);
  });

  it(`values nested deeper than ${MAX_DECODED_DEPTH} levels`, () => {
    const chain = (n: number): number[] => (n === 0 ? [0] : [1, ...chain(n - 1)]);
    expect(() => decodeBorsh({ defined: { name: "Nest" } }, Uint8Array.from(chain(MAX_DECODED_DEPTH - 1)), types)).not.toThrow();
    fails({ defined: { name: "Nest" } }, chain(MAX_DECODED_DEPTH + 1));
  });

  it("nested arrays of zero-sized elements, which read no data but would multiply out", () => {
    let type: unknown = { defined: { name: "Unit" } };
    for (let i = 0; i < 4; i++) type = { array: [type, 1024] };
    fails(type, []);
    fails({ array: [{ defined: { name: "Unit" } }, MAX_DECODED_VALUES + 1] }, []);
  });

  it("a fieldless struct at the depth limit can't push the value past it", () => {
    let type: unknown = { defined: { name: "Unit" } };
    for (let i = 0; i < MAX_DECODED_DEPTH; i++) type = { array: [type, 1] };
    fails(type, []);
    let ok: unknown = { defined: { name: "Unit" } };
    for (let i = 0; i < MAX_DECODED_DEPTH - 1; i++) ok = { array: [ok, 1] };
    expect(decodedValueSchema.safeParse(decodeBorsh(ok, new Uint8Array(0), types).value).success).toBe(true);
  });

  it("lengths that can't fit the data, or too many elements", () => {
    fails({ vec: "u64" }, [0xff, 0xff, 0xff, 0x0f]);
    fails({ vec: { defined: { name: "Unit" } } }, [0xff, 0xff, 0xff, 0x0f]); // zero-sized elements
    fails({ array: ["u8", 1_000_000] }, new Uint8Array(1_000_000));
    fails("bytes", cat(u32(5000), new Uint8Array(5000)));
  });
});
