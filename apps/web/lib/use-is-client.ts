import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => undefined;

/** False during SSR and hydration, true after: wallets are only detectable in the browser. */
export function useIsClient(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}
