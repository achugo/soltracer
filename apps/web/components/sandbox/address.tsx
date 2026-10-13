import { shortAddress } from "@/lib/format.ts";

/** A shortened, monospaced address with the full value in `title` and for screen readers. */
export function Address({ value, className = "" }: { value: string; className?: string }) {
  return (
    <span className={`font-mono ${className}`} title={value}>
      <span aria-hidden>{shortAddress(value)}</span>
      <span className="sr-only">{value}</span>
    </span>
  );
}
