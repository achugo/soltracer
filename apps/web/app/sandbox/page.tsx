import { FlaskConical } from "lucide-react";

export default function SandboxPage() {
  return (
    <section className="mx-auto max-w-5xl">
      <h1 className="mb-2 flex items-center gap-2 text-lg font-semibold">
        <FlaskConical className="size-5 text-violet-400" aria-hidden />
        Sandbox
      </h1>
      <p className="text-sm text-neutral-400">Paste a transaction to simulate it. Arrives in Phase 1.</p>
    </section>
  );
}
