import { nonceResponseSchema } from "@soltracer/shared";
import { NextResponse } from "next/server";
import { callEngine } from "@/lib/engine-client.ts";
import { webEnv } from "@/lib/env.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  const res = await callEngine(webEnv(), "/auth/nonce", { method: "POST" }, nonceResponseSchema);
  return NextResponse.json(res.body, { status: res.status, headers: { "cache-control": "no-store" } });
}
