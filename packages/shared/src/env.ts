import { z } from "zod";
import { hostSchema } from "./auth.ts";
import { pubkeySchema, type Pubkey } from "./solana.ts";

export type AllowlistResult = { ok: true; value: Pubkey[] } | { ok: false; invalid: string[] };

/** Parses a comma-separated list of wallet addresses, trimmed and deduped. */
export function parseAllowlist(raw: string): AllowlistResult {
  const entries = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0))];
  const invalid = entries.filter((e) => !pubkeySchema.safeParse(e).success);
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, value: entries };
}

const allowlistSchema = z.string().transform((raw, ctx) => {
  const result = parseAllowlist(raw);
  if (!result.ok) {
    ctx.addIssue({ code: "custom", message: `Invalid wallet addresses: ${result.invalid.join(", ")}` });
    return z.NEVER;
  }
  if (result.value.length === 0) {
    ctx.addIssue({ code: "custom", message: "ALLOWLIST needs at least one wallet address" });
    return z.NEVER;
  }
  return result.value;
});

const secret = (name: string) => z.string().min(32, `${name} must be at least 32 characters`);

const urlWithProtocol = (protocol: RegExp) => z.url({ protocol });

export const engineEnvSchema = z.object({
  HELIUS_API_KEY: z.string().min(1),
  HELIUS_RPC_URL: urlWithProtocol(/^https$/),
  HELIUS_WSS_URL: urlWithProtocol(/^wss$/),
  DATABASE_URL: urlWithProtocol(/^postgres(ql)?$/),
  ALLOWLIST: allowlistSchema,
  ENGINE_TOKEN: secret("ENGINE_TOKEN"),
  ENGINE_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
});

const appHostsSchema = z
  .string()
  .default("127.0.0.1:3000,localhost:3000")
  .transform((raw, ctx) => {
    const hosts: string[] = [];
    for (const entry of raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
      const host = hostSchema.safeParse(entry);
      if (!host.success) {
        ctx.addIssue({ code: "custom", message: `Invalid host in APP_HOSTS: ${entry}` });
        return z.NEVER;
      }
      if (!hosts.includes(host.data)) hosts.push(host.data);
    }
    if (hosts.length === 0) {
      ctx.addIssue({ code: "custom", message: "APP_HOSTS needs at least one host" });
      return z.NEVER;
    }
    return hosts;
  });

export const webEnvSchema = z.object({
  SESSION_SECRET: secret("SESSION_SECRET"),
  ENGINE_URL: urlWithProtocol(/^https?$/).default("http://127.0.0.1:4000"),
  /** Host headers the web app answers to (DNS-rebinding guard). Add your Tailscale name here. */
  APP_HOSTS: appHostsSchema,
  ENGINE_TOKEN: secret("ENGINE_TOKEN"),
});

export type EngineEnv = z.infer<typeof engineEnvSchema>;
export type WebEnv = z.infer<typeof webEnvSchema>;
