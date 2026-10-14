import { createHash } from "node:crypto";
import { MAX_INSTRUCTION_ACCOUNTS, type DecodedInstruction, type DecodedValue } from "@soltracer/shared/trace";
import { z } from "zod";
import { BorshError, BorshReader, readValue, type IdlTypeDefs } from "./borsh.ts";
import { IdlParseError } from "./idl.ts";

/**
 * An Anchor IDL reduced to what decoding needs, in one shape for both the current format
 * (explicit discriminators) and the legacy one (sha256 discriminators, camelCase names).
 * It is plain JSON, so it can be cached in jsonb and validated on the way back out.
 */
const discriminator = z.array(z.number().int().min(0).max(255)).min(1).max(32);

export const normalizedIdlSchema = z.object({
  instructions: z.array(
    z.object({
      name: z.string().min(1),
      discriminator,
      /** Flattened account names, in order; nested groups are "group.name". */
      accounts: z.array(z.string()),
      args: z.array(z.object({ name: z.string(), type: z.json() })),
    }),
  ),
  accounts: z.array(z.object({ name: z.string().min(1), discriminator })),
  types: z.array(z.object({ name: z.string().min(1), type: z.json() })),
});
export type NormalizedIdl = z.infer<typeof normalizedIdlSchema>;

const rawAccountItem: z.ZodType<RawAccountItem> = z.lazy(() =>
  z.object({ name: z.string(), accounts: z.array(rawAccountItem).optional() }),
);
interface RawAccountItem {
  name: string;
  accounts?: RawAccountItem[] | undefined;
}

const rawIdlSchema = z.object({
  instructions: z.array(
    z.object({
      name: z.string().min(1),
      discriminator: discriminator.optional(),
      accounts: z.array(rawAccountItem).default([]),
      args: z.array(z.object({ name: z.string(), type: z.json() })).default([]),
    }),
  ),
  accounts: z.array(z.object({ name: z.string().min(1), discriminator: discriminator.optional(), type: z.json().optional() })).default([]),
  types: z.array(z.object({ name: z.string().min(1), type: z.json() })).default([]),
});

/** Deepest JSON nesting accepted in an IDL; real IDLs stay far below it, and zod's recursion stays safe. */
const MAX_IDL_JSON_DEPTH = 64;

/** Nesting depth of parsed JSON, without recursion (a hostile IDL can nest far deeper than the stack). */
function jsonDepthExceeds(json: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[json, 0]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop() ?? [null, 0];
    if (value === null || typeof value !== "object") continue;
    if (depth >= max) return true;
    for (const child of Object.values(value)) stack.push([child, depth + 1]);
  }
  return false;
}

const sighash = (preimage: string) => [...createHash("sha256").update(preimage).digest().subarray(0, 8)];

/** Anchor's legacy instruction names are camelCase; their sighash uses snake_case ("routeV2" -> "route_v2"). */
function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function flattenAccounts(items: readonly RawAccountItem[], prefix = ""): string[] {
  return items.flatMap((item) =>
    item.accounts ? flattenAccounts(item.accounts, `${prefix}${item.name}.`) : [`${prefix}${item.name}`],
  );
}

/** Parses inflated IDL JSON (either format). Throws IdlParseError when it isn't an IDL. */
export function normalizeIdl(json: unknown): NormalizedIdl {
  if (jsonDepthExceeds(json, MAX_IDL_JSON_DEPTH)) throw new IdlParseError("IDL JSON nests too deeply");
  const raw = rawIdlSchema.safeParse(json);
  if (!raw.success) throw new IdlParseError("IDL JSON has an unexpected shape");
  const { instructions, accounts, types } = raw.data;
  return {
    instructions: instructions.map((ix) => ({
      name: ix.name,
      discriminator: ix.discriminator ?? sighash(`global:${snakeCase(ix.name)}`),
      accounts: flattenAccounts(ix.accounts),
      args: ix.args,
    })),
    accounts: accounts.map((a) => ({ name: a.name, discriminator: a.discriminator ?? sighash(`account:${a.name}`) })),
    // Legacy IDLs define account types inline; the current format puts them in `types`.
    types: [
      ...types,
      ...accounts.flatMap((a) => (a.type !== undefined && !types.some((t) => t.name === a.name) ? [{ name: a.name, type: a.type }] : [])),
    ],
  };
}

const typeDefsCache = new WeakMap<NormalizedIdl, IdlTypeDefs>();
function typeDefs(idl: NormalizedIdl): IdlTypeDefs {
  let defs = typeDefsCache.get(idl);
  if (!defs) {
    defs = new Map(idl.types.map((t) => [t.name, t.type]));
    typeDefsCache.set(idl, defs);
  }
  return defs;
}

const startsWith = (data: Uint8Array, prefix: readonly number[]) =>
  data.length >= prefix.length && prefix.every((b, i) => data[i] === b);

/** The entry whose discriminator prefixes the data; the longest wins, so a short one can't shadow it. */
function matchDiscriminator<T extends { discriminator: number[] }>(entries: readonly T[], data: Uint8Array): T | undefined {
  let best: T | undefined;
  for (const e of entries) {
    if (startsWith(data, e.discriminator) && e.discriminator.length > (best?.discriminator.length ?? 0)) best = e;
  }
  return best;
}

/**
 * Decodes instruction data against the IDL. Null (render raw) when no instruction matches, the
 * arguments don't decode, or bytes are left over: a strict match guards against a stale IDL.
 */
export function decodeIdlInstruction(idl: NormalizedIdl, data: Uint8Array, accountCount: number): DecodedInstruction | null {
  const ix = matchDiscriminator(idl.instructions, data);
  if (!ix) return null;
  const reader = new BorshReader(data, ix.discriminator.length);
  let args: Record<string, DecodedValue>;
  try {
    args = Object.fromEntries(ix.args.map((arg) => [arg.name, readValue(reader, arg.type, typeDefs(idl))]));
  } catch (err) {
    if (err instanceof BorshError) return null;
    throw err;
  }
  if (reader.offset !== data.length) return null;
  const count = Math.min(Math.max(0, accountCount), MAX_INSTRUCTION_ACCOUNTS);
  return { name: ix.name, args, accountNames: Array.from({ length: count }, (_, i) => ix.accounts[i] ?? null) };
}

/** Decodes account data by its discriminator. Trailing bytes are allowed: accounts are often padded. */
export function decodeIdlAccount(idl: NormalizedIdl, data: Uint8Array): { type: string; fields: Record<string, DecodedValue> } | null {
  const account = matchDiscriminator(idl.accounts, data);
  const def = account && typeDefs(idl).get(account.name);
  if (!account || account.name === "" || def === undefined) return null;
  try {
    const value = readValue(new BorshReader(data, account.discriminator.length), { defined: { name: account.name } }, typeDefs(idl));
    // Only named structs have fields to show; anything else renders raw.
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return { type: account.name, fields: value };
  } catch (err) {
    if (err instanceof BorshError) return null;
    throw err;
  }
}
