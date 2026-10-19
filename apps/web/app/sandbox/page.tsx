import { FlaskConical } from "lucide-react";
import type { Metadata } from "next";
import { QueryProvider } from "@/components/query-provider.tsx";
import { Sandbox } from "@/components/sandbox/sandbox.tsx";

export const metadata: Metadata = { title: "Sandbox · SolTracer" };

export default function SandboxPage() {
  return (
    <section className="mx-auto max-w-5xl">
      <h1 className="mb-2 flex items-center gap-2 text-lg font-semibold">
        <FlaskConical className="size-5 text-violet-400" aria-hidden />
        Sandbox
      </h1>
      <p className="mb-6 text-sm text-neutral-400">
        Paste a transaction to see what it will do. Signatures are not checked and the blockhash is replaced.
      </p>
      <QueryProvider>
        <Sandbox />
      </QueryProvider>
    </section>
  );
}
