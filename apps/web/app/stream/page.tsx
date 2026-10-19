import { Radio } from "lucide-react";

export default function StreamPage() {
  return (
    <section className="mx-auto max-w-5xl">
      <h1 className="mb-2 flex items-center gap-2 text-lg font-semibold">
        <Radio className="size-5 text-violet-400" aria-hidden />
        Stream
      </h1>
      <p className="text-sm text-neutral-400">Live activity for allowlisted wallets. Arrives in Phase 5.</p>
    </section>
  );
}
