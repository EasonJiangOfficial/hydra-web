// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type Op } from "@/lib/bank/fixtures/fake-db";
import { MissingEnvError } from "@/lib/bank/env";
import { WebhookVerifyError, type WebhookEvent } from "@/lib/bank/provider";

const mocks = vi.hoisted(() => ({
  verifyWebhook: vi.fn(),
  runSync: vi.fn(),
  createAdminClient: vi.fn(),
  after: vi.fn(),
  createLinkToken: vi.fn(),
  startUpdateMode: vi.fn(),
  exchangePublicToken: vi.fn(),
}));

vi.mock("@/lib/bank/plaid", () => ({ createPlaidProvider: () => ({ verifyWebhook: mocks.verifyWebhook }) }));
vi.mock("@/lib/bank/server", () => ({ runSync: mocks.runSync }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/bank/actions", () => ({
  createLinkToken: mocks.createLinkToken,
  startUpdateMode: mocks.startUpdateMode,
  exchangePublicToken: mocks.exchangePublicToken,
}));

const webhook = await import("./webhook/route");
const linkToken = await import("./link-token/route");
const exchange = await import("./exchange/route");

const BODY = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "plaid-item-1" }, null, 2);
const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://hydra.example/api/plaid/webhook", { method: "POST", body, headers });

let ops: Op[];
beforeEach(() => {
  vi.clearAllMocks();
  const db = fakeDb((op) => (op.filters.includes("provider_item_id=plaid-item-1") ? { data: { id: "item-row-1" } } : { data: null }));
  ops = db.ops;
  mocks.createAdminClient.mockReturnValue(db);
});

describe("POST /api/plaid/webhook", () => {
  it("refuses an unsigned or bad body with 401 and writes nothing", async () => {
    mocks.verifyWebhook.mockRejectedValue(new WebhookVerifyError("bad signature"));
    const res = await webhook.POST(post(BODY, { "plaid-verification": "x.y.z" }));
    expect(res.status).toBe(401);
    expect(ops).toEqual([]);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when Plaid is not configured", async () => {
    mocks.verifyWebhook.mockRejectedValue(new MissingEnvError("PLAID_CLIENT_ID"));
    expect((await webhook.POST(post(BODY))).status).toBe(503);
    expect(ops).toEqual([]);
  });

  it("verifies the exact raw body, queues the item and syncs it after the response", async () => {
    mocks.verifyWebhook.mockResolvedValue({ kind: "sync", providerItemId: "plaid-item-1" } satisfies WebhookEvent);
    const res = await webhook.POST(post(BODY, { "plaid-verification": "jwt" }));
    expect(res.status).toBe(200);
    expect(mocks.verifyWebhook).toHaveBeenCalledWith(BODY, expect.any(Headers));
    expect(ops[0]).toMatchObject({ table: "bank_items", action: "update", filters: ["provider=plaid", "provider_item_id=plaid-item-1"] });
    expect(ops[0].values).toEqual({ sync_requested_at: expect.any(String) });
    expect(mocks.runSync).not.toHaveBeenCalled();
    mocks.runSync.mockResolvedValue({ status: "synced", pages: 1, added: 2, modified: 0, removed: 0 });
    await mocks.after.mock.calls[0][0]();
    expect(mocks.runSync).toHaveBeenCalledWith("item-row-1");
  });

  it("records an item's new status", async () => {
    mocks.verifyWebhook.mockResolvedValue({ kind: "status", providerItemId: "plaid-item-1", status: "login_required", errorCode: "ITEM_LOGIN_REQUIRED" } satisfies WebhookEvent);
    expect((await webhook.POST(post(BODY))).status).toBe(200);
    expect(ops[0].values).toEqual({ status: "login_required", last_error: "ITEM_LOGIN_REQUIRED" });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("answers 200 to events it does not act on, and to unknown items", async () => {
    mocks.verifyWebhook.mockResolvedValue({ kind: "ignored", providerItemId: "plaid-item-1", code: "ITEM.WEBHOOK_UPDATE_ACKNOWLEDGED" } satisfies WebhookEvent);
    expect((await webhook.POST(post(BODY))).status).toBe(200);
    expect(ops).toEqual([]);
    mocks.verifyWebhook.mockResolvedValue({ kind: "sync", providerItemId: "someone-else" } satisfies WebhookEvent);
    expect((await webhook.POST(post(BODY))).status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled();
  });
});

describe("link-token and exchange routes", () => {
  const json = (url: string, body: unknown) =>
    new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  it("accept JSON only, so a cross-site form post never reaches an action", async () => {
    const form = new Request("https://hydra.example/api/plaid/exchange", { method: "POST", body: '{"publicToken":"p"}', headers: { "content-type": "text/plain" } });
    expect((await exchange.POST(form)).status).toBe(415);
    expect(mocks.exchangePublicToken).not.toHaveBeenCalled();
    const broken = new Request("https://hydra.example/api/plaid/link-token", { method: "POST", body: "{", headers: { "content-type": "application/json" } });
    expect((await linkToken.POST(broken)).status).toBe(400);
  });

  it("route a new link and update mode to their actions", async () => {
    mocks.createLinkToken.mockResolvedValue({ ok: true, data: { linkToken: "l1", expiration: "e" } });
    mocks.startUpdateMode.mockResolvedValue({ ok: true, data: { linkToken: "l2", expiration: "e" } });
    const fresh = await linkToken.POST(json("https://hydra.example/api/plaid/link-token", {}));
    expect(await fresh.json()).toEqual({ ok: true, data: { linkToken: "l1", expiration: "e" } });
    await linkToken.POST(json("https://hydra.example/api/plaid/link-token", { itemId: "item-row-1" }));
    expect(mocks.startUpdateMode).toHaveBeenCalledWith({ itemId: "item-row-1" });
  });

  it("map action errors to HTTP statuses", async () => {
    mocks.exchangePublicToken.mockResolvedValue({ ok: false, error: { code: "duplicate_institution", message: "m", itemId: "existing" } });
    expect((await exchange.POST(json("https://hydra.example/api/plaid/exchange", { publicToken: "p" }))).status).toBe(409);
    mocks.exchangePublicToken.mockResolvedValue({ ok: false, error: { code: "not_owner", message: "m" } });
    expect((await exchange.POST(json("https://hydra.example/api/plaid/exchange", { publicToken: "p" }))).status).toBe(403);
    mocks.exchangePublicToken.mockResolvedValue({ ok: false, error: { code: "INVALID_PUBLIC_TOKEN", message: "m" } });
    expect((await exchange.POST(json("https://hydra.example/api/plaid/exchange", { publicToken: "p" }))).status).toBe(502);
  });
});
