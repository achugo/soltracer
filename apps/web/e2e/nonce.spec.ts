import { buildLoginMessage, nonceResponseSchema } from "@soltracer/shared";
import { expect, test } from "@playwright/test";
import { allowedWallet, E2E_DOMAIN, e2eEnv } from "./env.ts";

async function signedBody(request: import("@playwright/test").APIRequestContext) {
  const nonce = nonceResponseSchema.parse(await (await request.get("/api/auth/nonce")).json());
  const message = buildLoginMessage(E2E_DOMAIN, nonce.nonce, nonce.issuedAt);
  return { publicKey: allowedWallet.address, signature: allowedWallet.sign(message), message };
}

test("a reused nonce is refused", async ({ request }) => {
  const body = await signedBody(request);
  expect((await request.post("/api/auth/verify", { data: body })).status()).toBe(200);
  const again = await request.post("/api/auth/verify", { data: body });
  expect(again.status()).toBe(401);
  expect(await again.json()).toMatchObject({ ok: false, code: "NONCE_USED" });
});

test("an expired nonce is refused", async ({ request }) => {
  const body = await signedBody(request);
  // Age the nonce in place rather than waiting five minutes.
  const { default: postgres } = await import("postgres");
  const sql = postgres(e2eEnv.DATABASE_URL, { max: 1 });
  const nonce = /Nonce: (\S+)/.exec(body.message)?.[1] ?? "";
  try {
    await sql`update auth_nonces set expires_at = now() - interval '1 second' where nonce = ${nonce}`;
  } finally {
    await sql.end();
  }

  const res = await request.post("/api/auth/verify", { data: body });
  expect(res.status()).toBe(401);
  expect(await res.json()).toMatchObject({ ok: false, code: "NONCE_EXPIRED" });
});

test("a Host header outside APP_HOSTS is refused (DNS rebinding)", async ({ request }) => {
  const res = await request.get("/api/auth/nonce", { headers: { host: "evil.example:3100" } });
  expect(res.status()).toBe(421);
  expect(await res.json()).toMatchObject({ ok: false, code: "HOST_NOT_ALLOWED" });
});

test("a message signed for another domain is refused", async ({ request }) => {
  const nonce = nonceResponseSchema.parse(await (await request.get("/api/auth/nonce")).json());
  const message = buildLoginMessage("evil.example", nonce.nonce, nonce.issuedAt);
  const res = await request.post("/api/auth/verify", {
    data: { publicKey: allowedWallet.address, signature: allowedWallet.sign(message), message },
  });
  expect(res.status()).toBe(400);
  expect(await res.json()).toMatchObject({ ok: false, code: "BAD_MESSAGE", message: expect.stringMatching(/different site/) });
});

test("the engine refuses requests without ENGINE_TOKEN", async ({ request }) => {
  const attempts: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }];
  for (const headers of attempts) {
    const res = await request.get(`${e2eEnv.ENGINE_URL}/health`, { headers });
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
  }
  const ok = await request.get(`${e2eEnv.ENGINE_URL}/health`, {
    headers: { authorization: `Bearer ${e2eEnv.ENGINE_TOKEN}` },
  });
  expect(ok.status()).toBe(200);
});
