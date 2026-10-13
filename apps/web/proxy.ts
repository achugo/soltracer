import { makeError } from "@soltracer/shared";
import { NextResponse, type NextRequest } from "next/server";
import { webEnv } from "./lib/env.ts";
import { decideAccess } from "./lib/route-guard.ts";
import { readSessionCookie, SESSION_COOKIE } from "./lib/session-cookie.ts";

export async function proxy(req: NextRequest) {
  const env = webEnv();
  const session = await readSessionCookie(req.cookies.get(SESSION_COOKIE)?.value, env.SESSION_SECRET);
  const decision = decideAccess({
    pathname: req.nextUrl.pathname,
    search: req.nextUrl.search,
    method: req.method,
    host: req.headers.get("host"),
    origin: req.headers.get("origin"),
    hasSession: session !== null,
    allowedHosts: env.APP_HOSTS,
  });

  switch (decision.type) {
    case "next":
      return NextResponse.next();
    case "redirect":
      return NextResponse.redirect(new URL(decision.to, req.url));
    case "unauthorized":
      return NextResponse.json(makeError("UNAUTHORIZED", "Sign in first."), { status: 401 });
    case "misdirected":
      return NextResponse.json(
        makeError("HOST_NOT_ALLOWED", "This host is not allowed. Add it to APP_HOSTS if it is yours."),
        { status: 421 },
      );
    case "forbidden":
      return NextResponse.json(makeError("UNAUTHORIZED", "Cross-origin request refused."), { status: 403 });
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
