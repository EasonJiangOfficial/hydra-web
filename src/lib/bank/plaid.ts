import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { PlaidClient, PlaidEnvironment, PlaidError, type Plaid } from "plaid";
import { plaidEnv } from "./env";
import {
  BankProviderError,
  toCents,
  WebhookVerifyError,
  type AccountKind,
  type BankProvider,
  type ProviderAccount,
  type ProviderTransaction,
  type WebhookEvent,
} from "./provider";

/**
 * Plaid adapter on the installed `plaid` SDK. Credentials come from the server env (./env.ts) and
 * fail closed. US institutions only (DESIGN.md section 2). Products: Transactions, plus Liabilities
 * when the bank offers it (card statement balance and due date).
 */

const NO_LIABILITIES = new Set([
  "PRODUCTS_NOT_SUPPORTED",
  "NO_LIABILITY_ACCOUNTS",
  "ADDITIONAL_CONSENT_REQUIRED",
  "PRODUCT_NOT_READY",
]);
const MAX_WEBHOOK_AGE_S = 5 * 60;

// ponytail: verification keys cached per kid for the life of the server instance; add a TTL if Plaid
// ever expires a key while an instance is warm (an expired key is refused when first fetched).
const keyCache = new Map<string, Plaid.JwkPublicKey>();

function providerError(error: unknown): unknown {
  if (!(error instanceof PlaidError)) return error;
  const code = (error.body as { error_code?: unknown } | undefined)?.error_code;
  return new BankProviderError(typeof code === "string" ? code : "PLAID_REQUEST_FAILED", error.statusCode);
}

async function call<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    throw providerError(error);
  }
}

function kindOf(type: string): AccountKind {
  if (type === "depository") return "cash";
  if (type === "credit") return "card";
  if (type === "loan") return "loan";
  return "asset";
}

const cents = (n: number | null | undefined) => (n == null ? null : toCents(n));

function toAccount(a: Plaid.AccountBase): ProviderAccount {
  return {
    providerAccountId: a.account_id,
    name: a.name,
    mask: a.mask ?? null,
    kind: kindOf(a.type),
    currentCents: cents(a.balances.current),
    availableCents: cents(a.balances.available),
    limitCents: cents(a.balances.limit),
  };
}

function toTransaction(t: Plaid.Transaction): ProviderTransaction {
  return {
    providerAccountId: t.account_id,
    providerTransactionId: t.transaction_id,
    pending: t.pending,
    pendingTransactionId: t.pending_transaction_id ?? null,
    postedOn: t.date,
    authorizedOn: t.authorized_date ?? null,
    amountCents: -toCents(t.amount) || 0, // Plaid: positive = money out. Hydra: positive = money in.
    name: t.name,
    merchant: t.merchant_name ?? null,
    rawDescription: t.original_description ?? null,
  };
}

function toEvent(body: Record<string, unknown>): WebhookEvent {
  const itemId = typeof body.item_id === "string" ? body.item_id : null;
  const type = String(body.webhook_type ?? "");
  const code = String(body.webhook_code ?? "");
  if (itemId && ((type === "TRANSACTIONS" && code === "SYNC_UPDATES_AVAILABLE") || (type === "LIABILITIES" && code === "DEFAULT_UPDATE"))) {
    return { kind: "sync", providerItemId: itemId };
  }
  if (itemId && type === "ITEM") {
    const errorCode = (body.error as { error_code?: string } | null | undefined)?.error_code ?? null;
    switch (code) {
      case "ERROR":
        return { kind: "status", providerItemId: itemId, status: errorCode === "ITEM_LOGIN_REQUIRED" ? "login_required" : "error", errorCode };
      case "PENDING_EXPIRATION":
      case "PENDING_DISCONNECT":
        return { kind: "status", providerItemId: itemId, status: "pending_expiration", errorCode: code };
      case "USER_PERMISSION_REVOKED":
      case "USER_ACCOUNT_REVOKED":
        return { kind: "status", providerItemId: itemId, status: "revoked", errorCode: code };
      case "LOGIN_REPAIRED":
        return { kind: "status", providerItemId: itemId, status: "active", errorCode: null };
    }
  }
  return { kind: "ignored", providerItemId: itemId, code: `${type}.${code}` };
}

function decodeSegment(segment: string): Record<string, unknown> {
  const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  if (!value || typeof value !== "object") throw new Error("not an object");
  return value;
}

export function createPlaidProvider(
  options: { config?: ReturnType<typeof plaidEnv>; fetch?: typeof fetch; now?: () => Date } = {},
): BankProvider {
  const config = options.config ?? plaidEnv();
  const now = options.now ?? (() => new Date());
  const client = new PlaidClient({
    environment: config.env === "production" ? PlaidEnvironment.Production : PlaidEnvironment.Sandbox,
    clientId: config.clientId,
    secret: config.secret,
    fetch: options.fetch,
    timeoutInSeconds: 30,
  });

  async function verificationKey(kid: string): Promise<Plaid.JwkPublicKey> {
    const cached = keyCache.get(kid);
    if (cached) return cached;
    let key: Plaid.JwkPublicKey;
    try {
      key = (await client.webhook.getVerificationKey({ key_id: kid })).key;
    } catch {
      throw new WebhookVerifyError("unknown key");
    }
    keyCache.set(kid, key);
    return key;
  }

  return {
    name: "plaid",

    async createLinkToken({ userId, webhookUrl, accessToken }) {
      const res = await call(() =>
        client.link.createToken({
          client_name: "Hydra",
          language: "en",
          country_codes: ["US"],
          user: { client_user_id: userId },
          ...(webhookUrl ? { webhook: webhookUrl } : {}),
          ...(accessToken
            ? { access_token: accessToken }
            : { products: ["transactions"], optional_products: ["liabilities"], transactions: { days_requested: 730 } }),
        }),
      );
      return { linkToken: res.link_token, expiration: res.expiration };
    },

    async exchangePublicToken(publicToken) {
      const exchanged = await call(() => client.item.exchangePublicToken({ public_token: publicToken }));
      // The token exists now: never lose it to a failed lookup (that would burn a Trial slot).
      const item = await call(() => client.item.get({ access_token: exchanged.access_token })).then(
        (res) => res.item,
        () => null,
      );
      return {
        accessToken: exchanged.access_token,
        providerItemId: exchanged.item_id,
        institutionId: item?.institution_id ?? null,
        institutionName: item?.institution_name ?? null,
      };
    },

    async syncTransactions(accessToken, cursor) {
      const res = await call(() =>
        client.transactions.sync({
          access_token: accessToken,
          cursor: cursor || undefined,
          count: 500,
          options: { include_original_description: true },
        }),
      );
      return {
        accounts: res.accounts.map(toAccount),
        added: res.added.map(toTransaction),
        modified: res.modified.map(toTransaction),
        removed: res.removed.map((r) => ({ providerTransactionId: r.transaction_id })),
        nextCursor: res.next_cursor,
        hasMore: res.has_more,
      };
    },

    async getBalances(accessToken) {
      // /accounts/get returns cached balances at no per-call cost; /accounts/balance/get is billed per call.
      const res = await call(() => client.accounts.get({ access_token: accessToken }));
      return res.accounts.map(toAccount);
    },

    async getCardStatements(accessToken) {
      try {
        const res = await call(() => client.liabilities.get({ access_token: accessToken }));
        return (res.liabilities.credit ?? []).flatMap((c) =>
          c.account_id
            ? [{ providerAccountId: c.account_id, statementBalanceCents: cents(c.last_statement_balance), dueOn: c.next_payment_due_date ?? null }]
            : [],
        );
      } catch (error) {
        if (error instanceof BankProviderError && NO_LIABILITIES.has(error.code)) return [];
        throw error;
      }
    },

    // Plaid's steps: https://plaid.com/docs/api/webhooks/webhook-verification/
    async verifyWebhook(rawBody, headers) {
      const jwt = headers.get("plaid-verification");
      const parts = jwt?.split(".") ?? [];
      if (parts.length !== 3) throw new WebhookVerifyError("missing or malformed signature");
      const [head, claims, signature] = parts;
      let header: Record<string, unknown>;
      let payload: Record<string, unknown>;
      try {
        header = decodeSegment(head);
        payload = decodeSegment(claims);
      } catch {
        throw new WebhookVerifyError("malformed signature");
      }
      if (header.alg !== "ES256" || typeof header.kid !== "string") throw new WebhookVerifyError("algorithm must be ES256");

      const jwk = await verificationKey(header.kid);
      if (jwk.expired_at != null) throw new WebhookVerifyError("key expired");
      const publicKey = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
      const signed = verify(
        "sha256",
        Buffer.from(`${head}.${claims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      );
      if (!signed) throw new WebhookVerifyError("bad signature");

      const age = now().getTime() / 1000 - Number(payload.iat);
      if (!Number.isFinite(age) || Math.abs(age) > MAX_WEBHOOK_AGE_S) throw new WebhookVerifyError("stale");

      const digest = Buffer.from(createHash("sha256").update(rawBody, "utf8").digest("hex"));
      const claimed = Buffer.from(String(payload.request_body_sha256 ?? ""));
      if (claimed.length !== digest.length || !timingSafeEqual(claimed, digest)) throw new WebhookVerifyError("body hash mismatch");

      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new WebhookVerifyError("body is not JSON");
      }
      if (!body || typeof body !== "object") throw new WebhookVerifyError("body is not an object");
      return toEvent(body as Record<string, unknown>);
    },

    async removeItem(accessToken) {
      await call(() => client.item.remove({ access_token: accessToken }));
    },
  };
}
