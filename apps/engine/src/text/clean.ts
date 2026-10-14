/**
 * Text from the chain (program logs, IDL names, decoded strings) can hold U+0000 or unpaired
 * surrogates. Both are valid in JS strings but Postgres jsonb rejects them, so they are replaced
 * with U+FFFD before anything is stored or returned.
 */
// Matching U+0000 is the point of this pattern.
// eslint-disable-next-line no-control-regex
const UNSAFE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const REPLACEMENT = String.fromCharCode(0xfffd);

export function cleanText(text: string): string {
  return text.replace(UNSAFE, REPLACEMENT);
}

/** cleanText over every string (and object key) in a JSON-like value. */
export function cleanJson<T>(value: T): T {
  if (typeof value === "string") return cleanText(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => cleanJson(v)) as T;
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array) && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [cleanText(k), cleanJson(v)])) as T;
  }
  return value;
}
