import { makeError } from "@soltracer/shared/errors";
import { NextResponse } from "next/server";
import { webEnv } from "@/lib/env.ts";
import { currentSession } from "@/lib/session.ts";
import { handleSimulate } from "@/lib/simulate-route.ts";

export const dynamic = "force-dynamic";

/** Matches the engine's /simulate body limit (1 MiB of override data is ~1.4 MB of base64). */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json(makeError("VALIDATION_ERROR", "Request is too large."), { status: 413 });
  }
  const session = await currentSession();
  // Only read the body once the caller is known to be signed in.
  const body: unknown = session ? await req.json().catch(() => undefined) : undefined;
  const res = await handleSimulate({ session, body, env: webEnv(), signal: req.signal });
  return NextResponse.json(res.body, { status: res.status, headers: { "cache-control": "no-store" } });
}
