import {
  makeError,
  nonceResponseSchema,
  engineVerifyRequestSchema,
  verifyResponseSchema,
} from "@soltracer/shared";
import Fastify, { type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { hasEngineToken } from "./auth/engine-token.ts";
import { issueNonce, verifyLogin } from "./auth/login.ts";
import { checkSessionWallet, needsSessionWallet, SESSION_WALLET_HEADER } from "./auth/session-wallet.ts";
import type { NonceStore } from "./auth/nonce-store.ts";
import type { EngineConfig } from "./config.ts";

const errorShape = z
  .looseObject({ statusCode: z.number().int().optional(), code: z.string().optional() })
  .catch({});

export const ENGINE_HOST = "127.0.0.1";

export interface ServerDeps {
  config: EngineConfig;
  nonceStore: NonceStore;
  logger?: FastifyServerOptions["logger"];
}

export function buildServer({ config, nonceStore, logger = true }: ServerDeps) {
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });

  app.addHook("onRequest", async (req, reply) => {
    if (!hasEngineToken(req.headers.authorization, config.ENGINE_TOKEN)) {
      return reply.code(401).send(makeError("UNAUTHORIZED", "Missing or invalid engine token."));
    }
    if (!needsSessionWallet(req.url)) return;
    switch (checkSessionWallet(req.headers[SESSION_WALLET_HEADER], config.ALLOWLIST)) {
      case "missing":
        return reply.code(401).send(makeError("UNAUTHORIZED", "Missing session wallet."));
      case "not-allowlisted":
        return reply
          .code(403)
          .send(makeError("NOT_ALLOWLISTED", "This wallet is no longer on the allowlist. Sign in again."));
      case "ok":
        return;
    }
  });

  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send(makeError("NOT_FOUND", "Route not found."));
  });

  app.setErrorHandler((err, req, reply) => {
    const { statusCode, code } = errorShape.parse(err);
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send(makeError("VALIDATION_ERROR", "The request could not be read.", { code }));
    }
    req.log.error({ err }, "unhandled engine error");
    return reply.code(500).send(makeError("INTERNAL", "Internal engine error."));
  });

  app.get("/health", async () => ({ ok: true }));

  app.post("/auth/nonce", async () => nonceResponseSchema.parse(await issueNonce(nonceStore, new Date())));

  app.post("/auth/verify", async (req, reply) => {
    const body = engineVerifyRequestSchema.safeParse(req.body);
    if (!body.success) {
      const issues = body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      return reply.code(400).send(makeError("VALIDATION_ERROR", "Invalid sign-in request.", issues));
    }
    const result = await verifyLogin(body.data, {
      store: nonceStore,
      allowlist: config.ALLOWLIST,
      now: new Date(),
    });
    if ("error" in result) return reply.code(result.status).send(result.error);
    return verifyResponseSchema.parse(result);
  });

  return app;
}
