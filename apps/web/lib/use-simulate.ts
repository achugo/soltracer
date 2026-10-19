import { useMutation } from "@tanstack/react-query";
import { postSimulate, type SimulateOutcome } from "./simulate-response.ts";

/** Runs one simulation. Always resolves with a result or a typed error; it never throws. */
export function useSimulate() {
  return useMutation<SimulateOutcome, never, string>({
    mutationKey: ["simulate"],
    mutationFn: (tx) => postSimulate(tx),
  });
}
