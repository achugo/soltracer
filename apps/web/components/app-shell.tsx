import { Activity, LogOut, Wallet } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { currentSession } from "@/lib/session.ts";
import { TabNav } from "./tab-nav.tsx";

const short = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;

export async function AppShell({ children }: { children: ReactNode }) {
  const session = await currentSession();
  // The proxy already redirects; this guards against a matcher gap.
  if (!session) redirect("/login");

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-neutral-800 px-4 py-2">
        <Link href="/sandbox" className="flex min-h-11 items-center gap-2 font-semibold">
          <Activity className="size-5 text-violet-400" aria-hidden />
          SolTracer
        </Link>
        <TabNav />
        <div className="ml-auto flex items-center gap-2">
          <span
            className="flex min-h-11 items-center gap-2 rounded-lg border border-neutral-800 px-3 font-mono text-xs"
            title={session.publicKey}
          >
            <Wallet className="size-4 text-violet-400" aria-hidden />
            <span className="sr-only">Signed in as </span>
            {short(session.publicKey)}
          </span>
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-neutral-300 hover:bg-neutral-900"
            >
              <LogOut className="size-4" aria-hidden />
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
