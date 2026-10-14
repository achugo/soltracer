import { MAX_DECODED_DEPTH, type DecodedValue } from "@soltracer/shared/trace";
import { getAddressDecoder } from "@solana/kit";
import { cleanText } from "../text/clean.ts";

/**
 * Borsh decoding driven by Anchor IDL type expressions, both the current format
 * ("pubkey", { defined: { name } }) and the legacy one ("publicKey", { defined: "Name" }).
 * Output is JSON: integers wider than 32 bits are decimal strings, pubkeys base58, bytes hex.
 * Anything it can't decode faithfully throws BorshError; callers fall back to raw bytes.
 */
export class BorshError extends Error {
  override name = "BorshError";
}

/** Named type definitions from an IDL's `types` (and legacy inline account types). */
export type IdlTypeDefs = ReadonlyMap<string, unknown>;

/** Most elements in one vec or array, and most bytes in one string or bytes value. */
export const MAX_DECODED_ELEMENTS = 1024;
export const MAX_DECODED_BYTES = 1024;
/** Most values decoded in one call: zero-sized elements would otherwise multiply without reading data. */
export const MAX_DECODED_VALUES = 4096;
/** Most characters of output (strings, hex, numbers, keys) one call may produce; names repeat for free otherwise. */
export const MAX_DECODED_CHARS = 64 * 1024;
/** Longest field or variant name used as output; IDL identifiers are short. */
export const MAX_IDL_NAME_CHARS = 128;
/** Most nested type expressions followed (bounds alias chains and self-references). */
const MAX_TYPE_NESTING = 64;

const addressDecoder = getAddressDecoder();
const utf8 = new TextDecoder("utf-8", { fatal: true });

const INTS: Record<string, { bytes: number; signed: boolean }> = {
  u8: { bytes: 1, signed: false },
  i8: { bytes: 1, signed: true },
  u16: { bytes: 2, signed: false },
  i16: { bytes: 2, signed: true },
  u32: { bytes: 4, signed: false },
  i32: { bytes: 4, signed: true },
  u64: { bytes: 8, signed: false },
  i64: { bytes: 8, signed: true },
  u128: { bytes: 16, signed: false },
  i128: { bytes: 16, signed: true },
  u256: { bytes: 32, signed: false },
  i256: { bytes: 32, signed: true },
};

export class BorshReader {
  offset: number;
  /** Values decoded so far through this reader; capped at MAX_DECODED_VALUES. */
  values = 0;
  /** Output characters produced so far; capped at MAX_DECODED_CHARS. */
  chars = 0;
  constructor(
    readonly data: Uint8Array,
    offset = 0,
  ) {
    this.offset = offset;
  }

  take(n: number): Uint8Array {
    if (n < 0 || this.offset + n > this.data.length) {
      throw new BorshError(`Needs ${n} bytes at offset ${this.offset}; only ${this.data.length - this.offset} left`);
    }
    const out = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  int(bytes: number, signed: boolean): bigint {
    const raw = this.take(bytes);
    let v = 0n;
    for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(raw[i] ?? 0);
    return signed ? BigInt.asIntN(bytes * 8, v) : v;
  }

  u32(): number {
    return Number(this.int(4, false));
  }

  /** Counts output text against the budget; returns it unchanged. */
  emit<T extends string>(text: T): T {
    this.chars += text.length;
    if (this.chars > MAX_DECODED_CHARS) throw new BorshError(`Decoded output exceeds ${MAX_DECODED_CHARS} characters`);
    return text;
  }
}

/** A field or variant name from the IDL, checked and counted. */
function idlName(reader: BorshReader, name: unknown): string {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_IDL_NAME_CHARS) throw new BorshError("Invalid IDL name");
  return reader.emit(cleanText(name));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Name of a `defined` reference in either IDL format. */
function definedName(ref: unknown): string {
  if (typeof ref === "string") return ref;
  if (isRecord(ref) && typeof ref.name === "string") {
    if (Array.isArray(ref.generics) && ref.generics.length > 0) throw new BorshError("Generic types are not supported");
    return ref.name;
  }
  throw new BorshError("Malformed defined type");
}

function checkLength(n: number, minElementBytes: number, reader: BorshReader, what: string) {
  if (n > MAX_DECODED_ELEMENTS) throw new BorshError(`${what} has ${n} elements; at most ${MAX_DECODED_ELEMENTS} are decoded`);
  if (n * minElementBytes > reader.data.length - reader.offset) throw new BorshError(`${what} length ${n} exceeds the data`);
}

/** Reads one value of `type`. `level` counts the containers already around it in the output. */
export function readValue(reader: BorshReader, type: unknown, types: IdlTypeDefs, level = 0, nesting = 0): DecodedValue {
  if (nesting > MAX_TYPE_NESTING) throw new BorshError("Type nesting too deep (self-referencing type?)");
  reader.values += 1;
  if (reader.values > MAX_DECODED_VALUES) throw new BorshError(`More than ${MAX_DECODED_VALUES} values`);
  const next = (t: unknown, lvl: number) => readValue(reader, t, types, lvl, nesting + 1);
  const container = () => {
    if (level + 1 > MAX_DECODED_DEPTH) throw new BorshError(`Value nests deeper than ${MAX_DECODED_DEPTH} levels`);
    return level + 1;
  };

  if (typeof type === "string") {
    const int = INTS[type];
    if (int) {
      const v = reader.int(int.bytes, int.signed);
      return int.bytes <= 4 ? Number(v) : reader.emit(v.toString());
    }
    switch (type) {
      case "bool": {
        const b = reader.take(1)[0];
        if (b !== 0 && b !== 1) throw new BorshError(`Invalid bool ${b}`);
        return b === 1;
      }
      case "f32":
      case "f64": {
        const raw = reader.take(type === "f32" ? 4 : 8);
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const f = type === "f32" ? view.getFloat32(0, true) : view.getFloat64(0, true);
        return Number.isFinite(f) ? f : reader.emit(String(f));
      }
      case "string":
      case "bytes": {
        const n = reader.u32();
        if (n > MAX_DECODED_BYTES) throw new BorshError(`${type} of ${n} bytes; at most ${MAX_DECODED_BYTES} are decoded`);
        const raw = reader.take(n);
        if (type === "bytes") return reader.emit(Buffer.from(raw).toString("hex"));
        try {
          return reader.emit(cleanText(utf8.decode(raw)));
        } catch {
          throw new BorshError("string is not UTF-8");
        }
      }
      case "pubkey":
      case "publicKey":
        return reader.emit(addressDecoder.decode(reader.take(32)));
      default:
        throw new BorshError(`Unknown type ${type}`);
    }
  }

  if (!isRecord(type)) throw new BorshError("Malformed type");
  if ("option" in type) {
    const tag = reader.take(1)[0];
    if (tag === 0) return null;
    if (tag !== 1) throw new BorshError(`Invalid option tag ${tag}`);
    return next(type.option, level);
  }
  if ("coption" in type) {
    const tag = reader.u32();
    if (tag === 0) return null;
    if (tag !== 1) throw new BorshError(`Invalid coption tag ${tag}`);
    return next(type.coption, level);
  }
  if ("vec" in type) {
    const lvl = container();
    const n = reader.u32();
    checkLength(n, 1, reader, "vec");
    return Array.from({ length: n }, () => next(type.vec, lvl));
  }
  if ("array" in type) {
    const lvl = container();
    const [inner, n] = Array.isArray(type.array) ? type.array : [];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new BorshError("Array length must be a number");
    checkLength(n, 0, reader, "array");
    return Array.from({ length: n }, () => next(inner, lvl));
  }
  if ("defined" in type) {
    const name = definedName(type.defined);
    const def = types.get(name);
    if (def === undefined) throw new BorshError(`Unknown defined type ${name}`);
    return readDefined(reader, def, types, level, nesting + 1);
  }
  throw new BorshError(`Unsupported type ${Object.keys(type).join(",")}`);
}

/** Reads a struct's or enum variant's fields: named ones as an object, tuple ones as an array. */
function readFields(reader: BorshReader, fields: unknown, types: IdlTypeDefs, level: number, nesting: number): DecodedValue {
  if (level > MAX_DECODED_DEPTH) throw new BorshError(`Value nests deeper than ${MAX_DECODED_DEPTH} levels`);
  if (fields === undefined) return {};
  if (!Array.isArray(fields)) throw new BorshError("Malformed fields");
  if (fields.every((f) => isRecord(f) && typeof f.name === "string")) {
    // fromEntries makes own properties, so a field named "__proto__" is kept rather than swallowed.
    return Object.fromEntries(
      (fields as Record<string, unknown>[]).map((f) => [idlName(reader, f.name), readValue(reader, f.type, types, level, nesting + 1)]),
    );
  }
  return fields.map((f) => readValue(reader, f, types, level, nesting + 1));
}

function readDefined(reader: BorshReader, def: unknown, types: IdlTypeDefs, level: number, nesting: number): DecodedValue {
  if (!isRecord(def)) throw new BorshError("Malformed type definition");
  // Zero-copy (bytemuck) layouts are C-style with padding, not borsh.
  if (def.serialization !== undefined && def.serialization !== "borsh") {
    throw new BorshError(`Unsupported serialization ${String(def.serialization)}`);
  }
  if (Array.isArray(def.generics) && def.generics.length > 0) throw new BorshError("Generic types are not supported");
  switch (def.kind) {
    case "struct":
      return readFields(reader, def.fields, types, level + 1, nesting);
    case "enum": {
      const variants = Array.isArray(def.variants) ? def.variants : [];
      const index = reader.take(1)[0] ?? -1;
      const variant: unknown = variants[index];
      if (!isRecord(variant) || typeof variant.name !== "string") throw new BorshError(`Invalid enum variant ${index}`);
      if (variant.fields === undefined) return idlName(reader, variant.name);
      if (level + 2 > MAX_DECODED_DEPTH) throw new BorshError(`Value nests deeper than ${MAX_DECODED_DEPTH} levels`);
      const name = idlName(reader, variant.name);
      return { [name]: readFields(reader, variant.fields, types, level + 2, nesting) };
    }
    case "type":
      return readValue(reader, def.alias, types, level, nesting + 1);
    default:
      throw new BorshError(`Unsupported type kind ${String(def.kind)}`);
  }
}

/** Decodes one value from the start of `data`; returns it and how many bytes it used. */
export function decodeBorsh(type: unknown, data: Uint8Array, types: IdlTypeDefs): { value: DecodedValue; offset: number } {
  const reader = new BorshReader(data);
  const value = readValue(reader, type, types);
  return { value, offset: reader.offset };
}
