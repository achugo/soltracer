import { NextResponse } from "next/server";
import { webEnv } from "@/lib/env.ts";
import { handleOptimize } from "@/lib/optimize-route.ts";
import { currentSession } from "@/lib/session.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await currentSession();
  // Only read the body once the caller is known to be signed in.
  const body: unknown = session ? await req.json().catch(() => undefined) : undefined;
  const res = await handleOptimize({ session, body, env: webEnv(), signal: req.signal });
  return NextResponse.json(res.body, { status: res.status, headers: { "cache-control": "no-store" } });
}
