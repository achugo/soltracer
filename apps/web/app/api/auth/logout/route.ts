import { getSessionHandle } from "@/lib/session.ts";

export async function POST() {
  const session = await getSessionHandle();
  session.destroy();
  // Relative Location keeps the browser on whatever host it used (localhost, 127.0.0.1 or Tailscale).
  return new Response(null, { status: 303, headers: { location: "/login" } });
}
