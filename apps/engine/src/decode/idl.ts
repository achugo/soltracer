import { inflateSync } from "node:zlib";
import { z } from "zod";

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

const idlSchema = z.object({
  errors: z.array(z.object({ code: z.number().int(), name: z.string(), msg: z.string().optional() })).optional(),
});

/** The error table from an on-chain Anchor IDL account. */
export function parseIdlErrors(data: Uint8Array): Map<number, IdlErrorInfo> {
  if (data.length < HEADER) throw new IdlParseError(`IDL account too short (${data.length} bytes)`);
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(40, true);
  if (length > data.length - HEADER) throw new IdlParseError(`IDL length ${length} exceeds account data`);
  let json: unknown;
  try {
    const text = inflateSync(data.subarray(HEADER, HEADER + length), { maxOutputLength: MAX_INFLATED_BYTES });
    json = JSON.parse(text.toString("utf8"));
  } catch (err) {
    throw new IdlParseError(`IDL could not be inflated or parsed: ${err instanceof Error ? err.message : "unknown"}`);
  }
  const idl = idlSchema.safeParse(json);
  if (!idl.success) throw new IdlParseError("IDL JSON has an unexpected shape");
  return new Map((idl.data.errors ?? []).map((e) => [e.code, { name: e.name, message: e.msg ?? e.name }]));
}
