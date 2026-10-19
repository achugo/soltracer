import { ChevronRight } from "lucide-react";

/** Open/closed marker for a `<summary>` inside `<details className="group">`; flex hides the native one. */
export function DisclosureChevron() {
  return (
    <ChevronRight
      className="size-4 shrink-0 text-neutral-400 group-open:rotate-90 motion-safe:transition-transform"
      aria-hidden
    />
  );
}
