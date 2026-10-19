import { inflateSync } from "node:zlib";
import { z } from "zod";
import { cleanText } from "../text/clean.ts";

export class IdlParseError extends Error {
  override name = "IdlParseError";
}

export interface IdlErrorInfo {
  name: string;
  message: string;
}

/** Anchor IDL account: discriminator(8) authority(32) data_len(u32) then zlib-compressed JSON. */
const HEADER = 44;
const MAX_INFLATED_BYTES = 5 * 1024 * 1024;
/** Most error codes kept from one IDL (real IDLs have tens). */
const MAX_IDL_ERRORS = 2000;

const idlSchema = z.object({
  errors: z.array(z.object({ code: z.number().int(), name: z.string(), msg: z.string().optional() })).optional(),
});

/** The IDL JSON inside an on-chain Anchor IDL account. */
export function inflateIdl(data: Uint8Array): unknown {
  if (data.length < HEADER) throw new IdlParseError(`IDL account too short (${data.length} bytes)`);
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(40, true);
  if (length > data.length - HEADER) throw new IdlParseError(`IDL length ${length} exceeds account data`);
  try {
    const text = inflateSync(data.subarray(HEADER, HEADER + length), { maxOutputLength: MAX_INFLATED_BYTES });
    return JSON.parse(text.toString("utf8"));
  } catch (err) {
    throw new IdlParseError(`IDL could not be inflated or parsed: ${err instanceof Error ? err.message : "unknown"}`);
  }
}

/** The error table from inflated IDL JSON. */
export function idlErrorsFromJson(json: unknown): Map<number, IdlErrorInfo> {
  const idl = idlSchema.safeParse(json);
  if (!idl.success) throw new IdlParseError("IDL JSON has an unexpected shape");
  // Names and messages are the program author's text: clean them and keep them short.
  return new Map(
    (idl.data.errors ?? []).slice(0, MAX_IDL_ERRORS).map((e) => [
      e.code,
      { name: cleanText(e.name).slice(0, 128), message: cleanText(e.msg ?? e.name).slice(0, 1024) },
    ]),
  );
}

/** The error table from an on-chain Anchor IDL account. */
export function parseIdlErrors(data: Uint8Array): Map<number, IdlErrorInfo> {
  return idlErrorsFromJson(inflateIdl(data));
}
