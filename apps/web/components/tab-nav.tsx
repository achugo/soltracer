"use client";

import { FlaskConical, Radio } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/sandbox", label: "Sandbox", Icon: FlaskConical },
  { href: "/stream", label: "Stream", Icon: Radio },
];

export function TabNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex gap-1">
      {TABS.map(({ href, label, Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm ${
              active
                ? "bg-violet-600/15 font-medium text-violet-300 underline decoration-violet-400 underline-offset-8"
                : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
            }`}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
