import { formatUnits, type SimulationResult } from "@soltracer/shared/simulation";
import { Scale } from "lucide-react";
import { formatDelta, LAMPORTS_DECIMALS } from "@/lib/format.ts";
import { groupBalances } from "@/lib/group-balances.ts";
import { Address } from "./address.tsx";
import { Card } from "./card.tsx";

const DELTA_CLASS = { up: "text-green-400", down: "text-red-400", none: "text-neutral-400" } as const;

function Delta({ delta, decimals }: { delta: string; decimals: number }) {
  const d = formatDelta(delta, decimals);
  return <span className={`font-mono ${DELTA_CLASS[d.direction]}`}>{d.text}</span>;
}

function Amount({ raw, decimals }: { raw: string; decimals: number }) {
  return <span className="font-mono">{formatUnits(raw, decimals)}</span>;
}

const th = "px-3 py-2 text-left font-medium text-neutral-400";
const td = "px-3 py-2 whitespace-nowrap";

export function BalanceTable({ balances, feePayer }: { balances: SimulationResult["balances"]; feePayer: string | null }) {
  const groups = groupBalances(balances, feePayer);
  return (
    <Card title="Balance changes" icon={<Scale className="size-4 text-violet-400" aria-hidden />}>
      {groups.length === 0 ? (
        <p className="text-sm text-neutral-400">No tracked balances changed.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <div key={g.owner} className="min-w-0">
              <h3 className="mb-1 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-neutral-400">Owner</span>
                <Address value={g.owner} className="text-neutral-100" />
                {g.isFeePayer && (
                  <span className="rounded border border-violet-800 px-1.5 text-xs text-violet-300">fee payer</span>
                )}
              </h3>
              <div className="overflow-x-auto rounded-md border border-neutral-800">
                <table className="w-full text-sm">
                  <thead className="bg-neutral-900">
                    <tr>
                      <th scope="col" className={th}>Asset</th>
                      <th scope="col" className={th}>Account</th>
                      <th scope="col" className={`${th} text-right`}>Before</th>
                      <th scope="col" className={`${th} text-right`}>After</th>
                      <th scope="col" className={`${th} text-right`}>Change</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-800">
                    {g.sol && (
                      <tr>
                        <td className={td}>SOL</td>
                        <td className={`${td} text-neutral-500`}>owner account</td>
                        <td className={`${td} text-right`}><Amount raw={g.sol.pre} decimals={LAMPORTS_DECIMALS} /></td>
                        <td className={`${td} text-right`}><Amount raw={g.sol.post} decimals={LAMPORTS_DECIMALS} /></td>
                        <td className={`${td} text-right`}><Delta delta={g.sol.delta} decimals={LAMPORTS_DECIMALS} /></td>
                      </tr>
                    )}
                    {g.tokenAccountSol.map(({ account, sol }) => (
                      <tr key={`sol-${account}`}>
                        <td className={td}>
                          SOL <span className="text-neutral-400">(token account rent)</span>
                        </td>
                        <td className={td}><Address value={account} className="text-neutral-300" /></td>
                        <td className={`${td} text-right`}><Amount raw={sol.pre} decimals={LAMPORTS_DECIMALS} /></td>
                        <td className={`${td} text-right`}><Amount raw={sol.post} decimals={LAMPORTS_DECIMALS} /></td>
                        <td className={`${td} text-right`}><Delta delta={sol.delta} decimals={LAMPORTS_DECIMALS} /></td>
                      </tr>
                    ))}
                    {g.tokens.map((t) => (
                      <tr key={t.account}>
                        <td className={td}>
                          <span className="text-neutral-400">Mint </span>
                          <Address value={t.mint} />
                          {t.program === "token-2022" && (
                            <span className="ml-2 rounded border border-neutral-700 px-1 text-xs text-neutral-400">Token-2022</span>
                          )}
                        </td>
                        <td className={td}><Address value={t.account} className="text-neutral-300" /></td>
                        <td className={`${td} text-right`}><Amount raw={t.pre} decimals={t.decimals} /></td>
                        <td className={`${td} text-right`}><Amount raw={t.post} decimals={t.decimals} /></td>
                        <td className={`${td} text-right`}><Delta delta={t.delta} decimals={t.decimals} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
