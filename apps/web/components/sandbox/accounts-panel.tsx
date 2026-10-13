import type { AccountRef } from "@soltracer/shared/simulation";
import { Address } from "./address.tsx";

const summaryClass =
  "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm font-semibold text-neutral-200 hover:bg-neutral-900";

/** Every account the transaction touches, including entries resolved from lookup tables. */
export function AccountsPanel({ accounts }: { accounts: AccountRef[] }) {
  return (
    <details className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-2">
      <summary className={summaryClass}>Accounts ({accounts.length})</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-neutral-400">
              <th scope="col" className="px-2 py-1 font-medium">#</th>
              <th scope="col" className="px-2 py-1 font-medium">Address</th>
              <th scope="col" className="px-2 py-1 font-medium">Access</th>
              <th scope="col" className="px-2 py-1 font-medium">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {accounts.map((a, i) => (
              <tr key={`${a.address}-${i}`}>
                <td className="px-2 py-1 font-mono text-neutral-500">{i}</td>
                <td className="px-2 py-1 whitespace-nowrap"><Address value={a.address} /></td>
                <td className="px-2 py-1 whitespace-nowrap">
                  {[a.writable ? "writable" : "read-only", a.signer ? "signer" : null].filter(Boolean).join(", ")}
                </td>
                <td className="px-2 py-1 whitespace-nowrap">
                  {a.source.kind === "static" ? (
                    "static"
                  ) : (
                    <>
                      lookup <Address value={a.source.table} /> <span className="font-mono">[{a.source.index}]</span>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
