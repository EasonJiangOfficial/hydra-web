// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MissingEnvError } from "@/lib/supabase/env";
import { InvalidEnvError, plaidEnv } from "./env";
import { defaultRoutes, fixtures, plaidFetch, sandboxConfig, webhookSigner } from "./fixtures/plaid-fetch";
import webhookItemError from "./fixtures/plaid/webhook_item_error.json";
import webhookSync from "./fixtures/plaid/webhook_sync_updates_available.json";
import { createPlaidProvider } from "./plaid";
import { BankProviderError, WebhookVerifyError } from "./provider";

const ACCESS = fixtures.itemPublicTokenExchange.access_token;
const NOW = new Date("2026-11-21T18:00:00Z");

function provider(routes = defaultRoutes()) {
  const { fetchFn, calls } = plaidFetch(routes);
  return { plaid: createPlaidProvider({ config: sandboxConfig, fetch: fetchFn, now: () => NOW }), calls };
}

describe("plaid env", () => {
  it("fails closed and names the missing variable", () => {
    expect(() => plaidEnv({ PLAID_SECRET: "s" })).toThrow(MissingEnvError);
    expect(() => plaidEnv({ PLAID_SECRET: "s" })).toThrow("PLAID_CLIENT_ID");
    expect(() => plaidEnv({ PLAID_CLIENT_ID: "c", PLAID_SECRET: " " })).toThrow("PLAID_SECRET");
  });
  it("defaults to sandbox and refuses an unknown environment", () => {
    expect(plaidEnv({ PLAID_CLIENT_ID: "c", PLAID_SECRET: "s" })).toEqual({ clientId: "c", secret: "s", env: "sandbox" });
    expect(plaidEnv({ PLAID_CLIENT_ID: "c", PLAID_SECRET: "s", PLAID_ENV: "Production" }).env).toBe("production");
    expect(() => plaidEnv({ PLAID_CLIENT_ID: "c", PLAID_SECRET: "s", PLAID_ENV: "development" })).toThrow(InvalidEnvError);
  });
  it("throws before any request when the env is missing", () => {
    vi.stubEnv("PLAID_CLIENT_ID", "");
    vi.stubEnv("PLAID_SECRET", "s");
    expect(() => createPlaidProvider()).toThrow(MissingEnvError);
    vi.unstubAllEnvs();
  });
});

describe("plaid adapter", () => {
  it("creates a link token for a new US login with transactions and optional liabilities", async () => {
    const { plaid, calls } = provider();
    const token = await plaid.createLinkToken({ userId: "owner-1", webhookUrl: "https://hydra.example/api/plaid/webhook" });
    expect(token).toEqual({ linkToken: fixtures.linkTokenCreate.link_token, expiration: fixtures.linkTokenCreate.expiration });
    const [call] = calls;
    expect(call.url).toBe("https://sandbox.plaid.com/link/token/create");
    expect(call.headers.get("plaid-client-id")).toBe("test-client-id");
    expect(call.headers.get("plaid-secret")).toBe("test-sandbox-secret");
    expect(call.body).toMatchObject({
      client_name: "Hydra",
      country_codes: ["US"],
      user: { client_user_id: "owner-1" },
      products: ["transactions"],
      optional_products: ["liabilities"],
      transactions: { days_requested: 730 },
      webhook: "https://hydra.example/api/plaid/webhook",
    });
    expect(call.body).not.toHaveProperty("access_token");
  });

  it("creates an update-mode link token on the same item, with no products", async () => {
    const { plaid, calls } = provider();
    await plaid.createLinkToken({ userId: "owner-1", accessToken: ACCESS });
    expect(calls[0].body).toMatchObject({ access_token: ACCESS });
    expect(calls[0].body).not.toHaveProperty("products");
  });

  it("exchanges a public token and reads the institution", async () => {
    const { plaid, calls } = provider();
    await expect(plaid.exchangePublicToken("public-sandbox-123")).resolves.toEqual({
      accessToken: ACCESS,
      providerItemId: fixtures.itemPublicTokenExchange.item_id,
      institutionId: "ins_109508",
      institutionName: "First Platypus Bank",
    });
    expect(calls.map((c) => c.path)).toEqual(["/item/public_token/exchange", "/item/get"]);
  });

  it("keeps the token when the institution lookup fails", async () => {
    const { plaid } = provider({ ...defaultRoutes(), "/item/get": { status: 500, body: { error_code: "INTERNAL_SERVER_ERROR" } } });
    const linked = await plaid.exchangePublicToken("public-sandbox-123");
    expect(linked).toMatchObject({ accessToken: ACCESS, institutionId: null });
  });

  it("maps a sync page to cents, Hydra's sign and the pending link", async () => {
    const { plaid, calls } = provider();
    const page1 = await plaid.syncTransactions(ACCESS, null);
    expect(calls[0].body).not.toHaveProperty("cursor");
    expect(calls[0].body).toMatchObject({ access_token: ACCESS, count: 500, options: { include_original_description: true } });
    expect(page1.hasMore).toBe(true);
    expect(page1.accounts).toEqual([
      { providerAccountId: expect.any(String), name: "Plaid Checking", mask: "0000", kind: "cash", currentCents: 11000, availableCents: 10000, limitCents: null },
      { providerAccountId: expect.any(String), name: "Plaid Credit Card", mask: "3333", kind: "card", currentCents: 41000, availableCents: null, limitCents: 200000 },
    ]);
    expect(page1.added.map((t) => [t.name, t.amountCents, t.pending])).toEqual([
      ["ACME CORP PAYROLL", 250000, false],
      ["Starbucks", -433, true],
    ]);

    const page2 = await plaid.syncTransactions(ACCESS, page1.nextCursor);
    expect(calls[1].body.cursor).toBe(page1.nextCursor);
    expect(page2.hasMore).toBe(false);
    expect(page2.added[0]).toEqual({
      providerAccountId: fixtures.syncPage2.added[0].account_id,
      providerTransactionId: "4ZVlAeRy7MCe5nkoxDZaHZ1kO7r9DKiPZ7Yvp",
      pending: false,
      pendingTransactionId: "no86Eox18VHMvaOVL7gPUM9ap3aR1LsAVZ5nc",
      postedOn: "2026-11-21",
      authorizedOn: "2026-11-19",
      amountCents: -473,
      name: "Starbucks",
      merchant: "Starbucks",
      rawDescription: "SQ *STARBUCKS #1234",
    });
    expect(page2.modified[0].amountCents).toBe(250001);
    expect(page2.removed).toEqual([{ providerTransactionId: "no86Eox18VHMvaOVL7gPUM9ap3aR1LsAVZ5nc" }]);
  });

  it("reads card statement balance and due date, and [] when the bank has none", async () => {
    const { plaid } = provider();
    await expect(plaid.getCardStatements(ACCESS)).resolves.toEqual([
      { providerAccountId: fixtures.liabilitiesGet.liabilities.credit[0].account_id, statementBalanceCents: 170877, dueOn: "2026-11-28" },
    ]);
    const none = provider({ ...defaultRoutes(), "/liabilities/get": { status: 400, body: fixtures.errorNoLiabilityAccounts } });
    await expect(none.plaid.getCardStatements(ACCESS)).resolves.toEqual([]);
  });

  it("turns a Plaid error into a coded error that carries no token", async () => {
    const { plaid } = provider({ ...defaultRoutes(), "/transactions/sync": { status: 400, body: fixtures.errorItemLoginRequired } });
    const error = await plaid.syncTransactions(ACCESS, null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankProviderError);
    expect(error).toMatchObject({ code: "ITEM_LOGIN_REQUIRED", status: 400 });
    expect(String((error as Error).message)).not.toContain(ACCESS);

    const mutated = provider({ ...defaultRoutes(), "/transactions/sync": { status: 400, body: fixtures.errorSyncMutation } });
    await expect(mutated.plaid.syncTransactions(ACCESS, "c1")).rejects.toMatchObject({ code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" });
  });
});

describe("plaid webhook verification", () => {
  const body = `${JSON.stringify(webhookSync, null, 2)}\n`;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  let kidCount = 0;

  function setup(expiredAt: number | null = null) {
    const kid = `kid-${++kidCount}-${Math.random()}`;
    const signer = webhookSigner(kid, expiredAt);
    const { plaid, calls } = provider({ ...defaultRoutes(), "/webhook_verification_key/get": signer.keyRoute });
    const headers = (jwt: string) => new Headers({ "Plaid-Verification": jwt });
    const claims = (raw: string, iat = NOW.getTime() / 1000 - 10) => ({ iat, request_body_sha256: sha(raw) });
    return { kid, signer, plaid, calls, headers, claims };
  }

  it("accepts a fresh, signed body and asks for a sync", async () => {
    const { kid, signer, plaid, calls, headers, claims } = setup();
    const jwt = signer.sign({ alg: "ES256", kid, typ: "JWT" }, claims(body));
    await expect(plaid.verifyWebhook(body, headers(jwt))).resolves.toEqual({ kind: "sync", providerItemId: webhookSync.item_id });
    expect(calls.find((c) => c.path === "/webhook_verification_key/get")?.body).toMatchObject({ key_id: kid });
  });

  it("maps an item error to login required", async () => {
    const { kid, signer, plaid, headers, claims } = setup();
    const raw = JSON.stringify(webhookItemError, null, 2);
    const jwt = signer.sign({ alg: "ES256", kid }, claims(raw));
    await expect(plaid.verifyWebhook(raw, headers(jwt))).resolves.toEqual({
      kind: "status",
      providerItemId: webhookItemError.item_id,
      status: "login_required",
      errorCode: "ITEM_LOGIN_REQUIRED",
    });
  });

  it("rejects a changed body, a stale or future token, another algorithm, an expired key and a bad signature", async () => {
    const { kid, signer, plaid, headers, claims } = setup();
    const ok = signer.sign({ alg: "ES256", kid }, claims(body));
    const reject = (raw: string, h: Headers) => expect(plaid.verifyWebhook(raw, h)).rejects.toBeInstanceOf(WebhookVerifyError);

    await reject(body.replace("SYNC_UPDATES_AVAILABLE", "DEFAULT_UPDATE"), headers(ok));
    await reject(JSON.stringify(webhookSync), headers(ok)); // whitespace counts
    await reject(body, headers(signer.sign({ alg: "ES256", kid }, claims(body, NOW.getTime() / 1000 - 301))));
    await reject(body, headers(signer.sign({ alg: "ES256", kid }, claims(body, NOW.getTime() / 1000 + 600))));
    await reject(body, headers(signer.sign({ alg: "HS256", kid }, claims(body))));
    await reject(body, headers(signer.sign({ alg: "none", kid }, claims(body))));
    const [h, p, s] = ok.split(".");
    await reject(body, headers(`${h}.${p}.${s.slice(0, -4)}AAAA`));
    await reject(body, new Headers());
    await reject(body, headers("not-a-jwt"));

    const other = webhookSigner(kid); // right kid, wrong private key
    await reject(body, headers(other.sign({ alg: "ES256", kid }, claims(body))));

    const expired = setup(1_700_000_100);
    await expect(
      expired.plaid.verifyWebhook(body, expired.headers(expired.signer.sign({ alg: "ES256", kid: expired.kid }, expired.claims(body)))),
    ).rejects.toThrow("key expired");
  });

  it("rejects a key id Plaid does not know", async () => {
    const { signer, headers, claims } = setup();
    const unknown = provider({ ...defaultRoutes(), "/webhook_verification_key/get": { status: 400, body: { error_code: "INVALID_FIELD" } } });
    await expect(
      unknown.plaid.verifyWebhook(body, headers(signer.sign({ alg: "ES256", kid: `missing-${Math.random()}` }, claims(body)))),
    ).rejects.toThrow("unknown key");
  });
});
