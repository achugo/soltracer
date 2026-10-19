import { readFileSync } from "node:fs";
import { z } from "zod";
import type { RpcCallRecord } from "../../src/rpc/client.ts";
import { parseRecordedJson } from "../../src/rpc/replay.ts";

export const STREAM_FIXTURES = ["jupiter-mentions"] as const;
export type StreamFixtureName = (typeof STREAM_FIXTURES)[number];

const fixtureSchema = z.object({
  address: z.string(),
  recordedAt: z.string(),
  /** A notified signature that succeeded, and one that failed; both have recorded getTransaction calls. */
  succeeded: z.string(),
  failed: z.string(),
  /** Every frame the Helius socket sent, in order (integers parsed as BigInt, as on the wire). */
  frames: z.array(z.unknown()),
  rpc: z.array(z.custom<RpcCallRecord>()),
});

export type StreamFixture = z.infer<typeof fixtureSchema>;

/** A real logsSubscribe session recorded by `fixtures record-stream`, plus the hydration calls. */
export function loadStreamFixture(name: StreamFixtureName): StreamFixture {
  const text = readFileSync(new URL(`../fixtures/stream/${name}.stream.json`, import.meta.url), "utf8");
  return fixtureSchema.parse(parseRecordedJson(text));
}

/** The raw text of each frame, as the socket delivered it (re-serialized with exact integers). */
export function frameTexts(fixture: StreamFixture): string[] {
  const { rawJSON } = JSON as unknown as { rawJSON(text: string): unknown };
  return fixture.frames.map((f) => JSON.stringify(f, (_k, v: unknown) => (typeof v === "bigint" ? rawJSON(v.toString()) : v)));
}
