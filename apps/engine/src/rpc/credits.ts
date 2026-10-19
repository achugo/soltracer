/**
 * Helius credits per RPC method. Standard calls cost 1 credit. Heavier and archival
 * methods are priced conservatively high so the logged totals never undercount;
 * check against the Helius dashboard when adding a method.
 */
const CREDITS: Readonly<Record<string, number>> = {
  getProgramAccounts: 10,
  getTransaction: 10,
  getSignaturesForAddress: 10,
  getBlock: 10,
};

export function creditsFor(method: string): number {
  return CREDITS[method] ?? 1;
}
