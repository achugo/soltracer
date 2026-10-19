import { sessionSchema, type Session } from "@soltracer/shared";
import { unsealData } from "iron-session";

export const SESSION_COOKIE = "soltracer_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Unseals and validates a session cookie value. Null for anything invalid or expired. */
export async function readSessionCookie(value: string | undefined, password: string): Promise<Session | null> {
  if (!value) return null;
  try {
    const data = await unsealData<unknown>(value, { password, ttl: SESSION_TTL_SECONDS });
    const parsed = sessionSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
