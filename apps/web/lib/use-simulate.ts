import { useMutation } from "@tanstack/react-query";
import { postSimulate, type SimulateInput, type SimulateOutcome } from "./simulate-response.ts";

/** Runs one simulation. Always resolves with a result or a typed error; it never throws. */
export function useSimulate() {
  return useMutation<SimulateOutcome, never, SimulateInput>({
    mutationKey: ["simulate"],
    mutationFn: (request) => postSimulate(request),
  });
}
