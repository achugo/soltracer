import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  isJsonRpcPayload,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type Rpc,
  type RpcTransport,
  type SolanaRpcApi,
} from "@solana/kit";
import { z } from "zod";
import { creditsFor } from "./credits.ts";
import type { RateLimiter } from "./rate-limiter.ts";

export type SolanaRpc = Rpc<SolanaRpcApi>;

// kit's transport parses JSON integers as bigint, so the code may arrive as either.
const jsonRpcErrorSchema = z.object({ code: z.union([z.number(), z.bigint()]).transform(Number), message: z.string() });

const stringifySafe = (value: unknown) =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

export interface RpcLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface RpcCallRecord {
  method: string;
  params: unknown;
  response: unknown;
}

/** Typed RPC failure. Its message never contains the RPC URL or API key. */
export class RpcError extends Error {
  constructor(
    readonly code: "RPC_ERROR" | "RPC_RATE_LIMITED",
    readonly method: string,
    message: string,
    /** Safe, redacted context such as the JSON-RPC error code. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface RpcSession {
  rpc: SolanaRpc;
  /** Credits spent by calls made through this session. */
  credits(): number;
}

export interface RpcClient {
  /** A metered view of the shared client; one per simulation. `record` captures calls for fixtures. */
  session(options?: { record?: RpcCallRecord[] }): RpcSession;
}

export interface RpcClientOptions {
  url: string;
  limiter: RateLimiter;
  log: RpcLogger;
  /** Inner transport; defaults to kit's HTTP transport. Tests and fixture replay inject their own. */
  transport?: RpcTransport;
}

/** Replaces the RPC URL and any api-key value in free text. */
export function redact(text: string, url: string): string {
  return text.split(url).join("<rpc-url>").replace(/api-key=[^&\s"']+/gi, "api-key=***");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The engine's only path to Helius: rate-limited, metered, logged and redacted. */
export function createRpcClient({ url, limiter, log, transport }: RpcClientOptions): RpcClient {
  const inner = transport ?? createDefaultRpcTransport({ url });

  return {
    session(options = {}) {
      let credits = 0;
      const metered = (async (config: Parameters<RpcTransport>[0]) => {
        const { method, params } = isJsonRpcPayload(config.payload)
          ? config.payload
          : { method: "unknown", params: undefined };
        await limiter.take(config.signal);
        const cost = creditsFor(method);
        credits += cost;
        const started = performance.now();
        let response: unknown;
        try {
          response = await inner(config);
        } catch (err) {
          const rateLimited =
            isSolanaError(err, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && err.context.statusCode === 429;
          const message = redact(messageOf(err), url);
          const durationMs = Math.round(performance.now() - started);
          log.warn({ rpc: method, credits: cost, durationMs, rateLimited }, "rpc call failed");
          throw new RpcError(rateLimited ? "RPC_RATE_LIMITED" : "RPC_ERROR", method, `${method} failed: ${message}`);
        }
        const durationMs = Math.round(performance.now() - started);
        options.record?.push({ method, params, response });
        if (typeof response === "object" && response !== null && "error" in response) {
          const rpcError = jsonRpcErrorSchema.safeParse(response.error);
          const code = rpcError.success ? rpcError.data.code : null;
          const detail = redact(rpcError.success ? rpcError.data.message : stringifySafe(response.error), url);
          log.warn({ rpc: method, credits: cost, durationMs, jsonRpcCode: code }, "rpc call returned an error");
          throw new RpcError("RPC_ERROR", method, `${method} returned an error: ${detail}`, { jsonRpcCode: code });
        }
        log.info({ rpc: method, credits: cost, durationMs }, "rpc call");
        return response;
      }) as RpcTransport;

      return { rpc: createSolanaRpcFromTransport(metered), credits: () => credits };
    },
  };
}
