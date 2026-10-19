import type { ReactNode } from "react";

/** Bordered panel with a heading; every result section uses it. */
export function Card({ title, icon, children, className = "" }: { title: string; icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 ${className}`}>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-200">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Badge({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-300">
      {children}
    </span>
  );
}
