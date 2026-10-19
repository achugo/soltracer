import { hostSchema, makeError, verifyRequestSchema, verifyResponseSchema } from "@soltracer/shared";
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

  // proxy.ts has already checked Host against APP_HOSTS; the engine checks the signed Domain matches it.
  const domain = hostSchema.safeParse(req.headers.get("host") ?? "");
  if (!domain.success) {
    return NextResponse.json(makeError("HOST_NOT_ALLOWED", "Missing or invalid Host header."), { status: 421 });
  }

  const res = await callEngine(
    webEnv(),
    "/auth/verify",
    { method: "POST", body: { ...body.data, domain: domain.data } },
    verifyResponseSchema,
  );
  if (!res.body.ok) return NextResponse.json(res.body, { status: res.status });

  const session = await getSessionHandle();
  session.publicKey = res.body.publicKey;
  session.signedInAt = new Date().toISOString();
  await session.save();
  return NextResponse.json(res.body);
}
