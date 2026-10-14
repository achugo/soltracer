import type { FeePreset } from "@soltracer/shared/optimize";
import { useMutation } from "@tanstack/react-query";
import { postOptimize, postTxStatus, type OptimizeOutcome, type TxStatusOutcome } from "./optimize-response.ts";

/** One optimize run per call; mutations never retry, which matters here because each run spends credits. */
export function useOptimize() {
  return useMutation<OptimizeOutcome, never, { tx: string; preset: FeePreset }>({
    mutationKey: ["optimize"],
    mutationFn: ({ tx, preset }) => postOptimize(tx, preset),
    retry: false,
  });
}

/** One status lookup per call; there is no polling. */
export function useTxStatus() {
  return useMutation<TxStatusOutcome, never, string>({
    mutationKey: ["tx-status"],
    mutationFn: (signature) => postTxStatus(signature),
    retry: false,
  });
}
