import { ShieldAlert, TriangleAlert } from "lucide-react";
import type { WarningView } from "@/lib/optimize-view.ts";

const TONE = {
  danger: { box: "border-red-900/70 bg-red-950/30", title: "text-red-200", icon: "text-red-400", Icon: ShieldAlert },
  caution: { box: "border-amber-900/70 bg-amber-950/30", title: "text-amber-200", icon: "text-amber-400", Icon: TriangleAlert },
} as const;

export function OptimizeWarnings({ warnings }: { warnings: WarningView[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul aria-label="Warnings" className="flex flex-col gap-2">
      {warnings.map((w) => {
        const t = TONE[w.tone];
        return (
          <li key={w.code} role="note" className={`rounded-lg border p-3 text-sm ${t.box}`}>
            <div className="flex items-start gap-2">
              <t.Icon className={`mt-0.5 size-4 shrink-0 ${t.icon}`} aria-hidden />
              <div className="min-w-0 flex-1 space-y-1">
                <p className={`font-semibold ${t.title}`}>
                  {w.tone === "danger" ? "Warning: " : "Caution: "}
                  {w.title}
                </p>
                <p className="break-words text-neutral-300">{w.message}</p>
                {w.facts.length > 0 && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                    {w.facts.map((f) => (
                      <div key={f.label} className="contents">
                        <dt className="text-neutral-400">{f.label}</dt>
                        <dd className="break-all font-mono text-neutral-100">{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
