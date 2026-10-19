import type { Session } from "@soltracer/shared";
import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { webEnv } from "./env.ts";
import { readSessionCookie, SESSION_COOKIE, SESSION_TTL_SECONDS } from "./session-cookie.ts";

function sessionOptions(): SessionOptions {
  return {
    cookieName: SESSION_COOKIE,
    password: webEnv().SESSION_SECRET,
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    },
  };
}

/** Mutable iron-session handle for route handlers that sign in or out. */
export async function getSessionHandle() {
  return getIronSession<Partial<Session>>(await cookies(), sessionOptions());
}

/** The validated session for the current request, or null. */
export async function currentSession(): Promise<Session | null> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  return readSessionCookie(value, webEnv().SESSION_SECRET);
}
