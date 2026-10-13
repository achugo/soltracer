import { makeError, verifyRequestSchema, verifyResponseSchema } from "@soltracer/shared";
import { NextResponse } from "next/server";
import { callEngine } from "@/lib/engine-client.ts";
import { webEnv } from "@/lib/env.ts";
import { getSessionHandle } from "@/lib/session.ts";

export async function POST(req: Request) {
  const json: unknown = await req.json().catch(() => null);
  const body = verifyRequestSchema.safeParse(json);
  if (!body.success) {
    return NextResponse.json(makeError("VALIDATION_ERROR", "Invalid sign-in request."), { status: 400 });
  }

  const res = await callEngine(webEnv(), "/auth/verify", { method: "POST", body: body.data }, verifyResponseSchema);
  if (!res.body.ok) return NextResponse.json(res.body, { status: res.status });

  const session = await getSessionHandle();
  session.publicKey = res.body.publicKey;
  session.signedInAt = new Date().toISOString();
  await session.save();
  return NextResponse.json(res.body);
}
