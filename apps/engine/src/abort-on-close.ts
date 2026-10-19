import type { EventEmitter } from "node:events";

/**
 * A signal that aborts if the client disconnects before the response is finished,
 * so queued and in-flight RPC calls for an abandoned request stop spending credits.
 */
export function abortWhenClientLeaves(res: EventEmitter & { writableEnded: boolean }): AbortSignal {
  const controller = new AbortController();
  res.once("close", () => {
    // writableEnded: we called end(), so the close is ours, not the client leaving.
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}
