import { generateKeyPairSync, sign } from "node:crypto";
import errorItemLoginRequired from "./plaid/error_item_login_required.json";
import errorNoLiabilityAccounts from "./plaid/error_no_liability_accounts.json";
import errorSyncMutation from "./plaid/error_sync_mutation.json";
import itemGet from "./plaid/item_get.json";
import itemPublicTokenExchange from "./plaid/item_public_token_exchange.json";
import liabilitiesGet from "./plaid/liabilities_get.json";
import linkTokenCreate from "./plaid/link_token_create.json";
import syncPage1 from "./plaid/transactions_sync_page1.json";
import syncPage2 from "./plaid/transactions_sync_page2.json";

/**
 * Test support: a `fetch` that answers like Plaid Sandbox from the JSON fixtures in ./plaid (shaped
 * from Plaid's API reference examples; not captured from a live run). Passed to the real SDK
 * through createPlaidProvider({ fetch }), so requests and responses go through the SDK as in production.
 */

export const fixtures = {
  errorItemLoginRequired,
  errorNoLiabilityAccounts,
  errorSyncMutation,
  itemGet,
  itemPublicTokenExchange,
  liabilitiesGet,
  linkTokenCreate,
  syncPage1,
  syncPage2,
};

export type Reply = { status?: number; body: unknown };
export type Route = Reply | ((body: Record<string, unknown>, call: number) => Reply);

export interface PlaidCall {
  url: string;
  path: string;
  body: Record<string, unknown>;
  headers: Headers;
}

/** Default routes; a sync answers page 1 for no cursor and page 2 for page 1's cursor. */
export function defaultRoutes(): Record<string, Route> {
  return {
    "/link/token/create": { body: linkTokenCreate },
    "/item/public_token/exchange": { body: itemPublicTokenExchange },
    "/item/get": { body: itemGet },
    "/item/remove": { body: { request_id: "remove1" } },
    "/liabilities/get": { body: liabilitiesGet },
    "/transactions/sync": (body) => ({ body: body.cursor === syncPage1.next_cursor ? syncPage2 : syncPage1 }),
  };
}

export function plaidFetch(routes: Record<string, Route> = defaultRoutes()) {
  const calls: PlaidCall[] = [];
  const counts = new Map<string, number>();
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, path, body, headers: new Headers(init?.headers as HeadersInit) });
    const n = counts.get(path) ?? 0;
    counts.set(path, n + 1);
    const route = routes[path];
    if (!route) return Response.json({ error_code: "NOT_MOCKED", error_type: "API_ERROR" }, { status: 400 });
    const reply = typeof route === "function" ? route(body, n) : route;
    return Response.json(reply.body, { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

export const sandboxConfig = { clientId: "test-client-id", secret: "test-sandbox-secret", env: "sandbox" as const };

/** An ES256 key pair and a signer for Plaid-style webhook JWTs. */
export function webhookSigner(kid: string, expiredAt: number | null = null) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...publicKey.export({ format: "jwk" }), alg: "ES256", use: "sig", kid, created_at: 1_700_000_000, expired_at: expiredAt };
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return {
    keyRoute: { body: { key: jwk, request_id: "keyreq1" } } satisfies Reply,
    sign(header: Record<string, unknown>, payload: Record<string, unknown>) {
      const input = `${enc(header)}.${enc(payload)}`;
      const signature = sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" });
      return `${input}.${signature.toString("base64url")}`;
    },
  };
}
