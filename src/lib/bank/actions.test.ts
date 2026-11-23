// @vitest-environment node
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptToken, encryptToken } from "./crypto";
import { fakeDb, type Op, type Reply } from "./fixtures/fake-db";
import { parseImport, withImportHashes } from "./import";

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  runSync: vi.fn(),
  createAdminClient: vi.fn(),
  createPlaidProvider: vi.fn(),
  after: vi.fn(),
  processIngested: vi.fn(async () => ({ checked: 0, changed: 0, paired: 0 })),
  detectAndSaveRecurring: vi.fn(async () => ({ found: 0, saved: 0 })),
}));
vi.mock("@/lib/rules/engine", () => ({ processIngested: mocks.processIngested, detectAndSaveRecurring: mocks.detectAndSaveRecurring }));

vi.mock("./server", () => ({
  NotOwnerError: class NotOwnerError extends Error {},
  requireOwner: mocks.requireOwner,
  runSync: mocks.runSync,
  webhookUrl: async () => "https://hydra.example/api/plaid/webhook",
  ownerToday: async () => "2026-11-21",
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("./plaid", () => ({ createPlaidProvider: mocks.createPlaidProvider }));
vi.mock("next/server", () => ({ after: mocks.after }));

const { addManualTransaction, createLinkToken, editAccount, editTransaction, exchangePublicToken, importFile, startUpdateMode } = await import("./actions");
const { NotOwnerError } = await import("./server");

const KEY = randomBytes(32);
const ACCESS = "access-sandbox-de3ce8ef-33f8-452c-a685-8671031fc0f6";
const PLAID_ITEM = "Ed6bjNrDLJfGvZWwnkQlfxwoNz54B5C97ejBr";
const ACCOUNT = "bbbbbbbb-0000-4000-8000-000000000001";
const TX = "cccccccc-0000-4000-8000-000000000001";

const provider = {
  createLinkToken: vi.fn(async () => ({ linkToken: "link-sandbox-1", expiration: "2026-11-21T22:05:00Z" })),
  exchangePublicToken: vi.fn(async () => ({ accessToken: ACCESS, providerItemId: PLAID_ITEM, institutionId: "ins_109508", institutionName: "First Platypus Bank" })),
  removeItem: vi.fn(async () => {}),
};

function owner(reply: (op: Op) => Reply = () => ({})) {
  const db = fakeDb(reply);
  mocks.requireOwner.mockResolvedValue({ db, userId: "owner-uid" });
  return db;
}

function admin(reply: (op: Op) => Reply) {
  const db = fakeDb(reply);
  mocks.createAdminClient.mockReturnValue(db);
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HYDRA_TOKEN_KEY", KEY.toString("base64"));
  mocks.createPlaidProvider.mockReturnValue(provider);
});

describe("owner and input checks", () => {
  it("refuses a caller who is not the owner before touching the bank", async () => {
    mocks.requireOwner.mockRejectedValue(new NotOwnerError());
    await expect(exchangePublicToken({ publicToken: "public-sandbox-1" })).resolves.toEqual({
      ok: false,
      error: { code: "not_owner", message: "Sign in as the owner" },
    });
    expect(provider.exchangePublicToken).not.toHaveBeenCalled();
  });

  it("refuses bad input", async () => {
    owner();
    const result = await exchangePublicToken({ publicToken: "  " });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(provider.exchangePublicToken).not.toHaveBeenCalled();
  });
});

describe("linking", () => {
  it("creates a link token for the owner with the webhook", async () => {
    owner();
    await expect(createLinkToken()).resolves.toEqual({ ok: true, data: { linkToken: "link-sandbox-1", expiration: "2026-11-21T22:05:00Z" } });
    expect(provider.createLinkToken).toHaveBeenCalledWith({ userId: "owner-uid", webhookUrl: "https://hydra.example/api/plaid/webhook" });
  });

  it("stores the access token encrypted and bound to its item, then syncs after the response", async () => {
    owner();
    const db = admin((op) => (op.action === "insert" ? { data: { id: "item-row-1" } } : {}));
    await expect(exchangePublicToken({ publicToken: "public-sandbox-1" })).resolves.toEqual({
      ok: true,
      data: { itemId: "item-row-1", institutionName: "First Platypus Bank" },
    });
    const saved = db.ops[0].values as Record<string, string>;
    expect(saved).toMatchObject({ provider: "plaid", provider_item_id: PLAID_ITEM, institution_id: "ins_109508" });
    expect(saved.access_token).toMatch(/^v1\./);
    expect(JSON.stringify(db.ops)).not.toContain(ACCESS);
    expect(decryptToken(saved.access_token, PLAID_ITEM, KEY)).toBe(ACCESS);

    expect(mocks.after).toHaveBeenCalledTimes(1);
    mocks.runSync.mockResolvedValue({ status: "synced", pages: 1, added: 0, modified: 0, removed: 0 });
    await mocks.after.mock.calls[0][0]();
    expect(mocks.runSync).toHaveBeenCalledWith("item-row-1");
  });

  it("blocks a second link to the same institution and removes the new Plaid item", async () => {
    owner();
    admin((op) => {
      if (op.action === "insert") return { error: { code: "23505", message: "duplicate key" } };
      if (op.filters.includes(`provider_item_id=${PLAID_ITEM}`)) return { data: null };
      if (op.filters.includes("institution_id=ins_109508")) return { data: { id: "existing-item" } };
      return {};
    });
    await expect(exchangePublicToken({ publicToken: "public-sandbox-2" })).resolves.toEqual({
      ok: false,
      error: { code: "duplicate_institution", message: "This bank is already linked. Repair it with update mode.", itemId: "existing-item" },
    });
    expect(provider.removeItem).toHaveBeenCalledWith(ACCESS);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("treats a retried exchange of the same item as done and never removes the live item", async () => {
    owner();
    admin((op) => {
      if (op.action === "insert") return { error: { code: "23505", message: "duplicate key" } };
      if (op.filters.includes(`provider_item_id=${PLAID_ITEM}`)) return { data: { id: "item-row-1" } };
      return {};
    });
    await expect(exchangePublicToken({ publicToken: "public-sandbox-1" })).resolves.toMatchObject({ ok: true, data: { itemId: "item-row-1" } });
    expect(provider.removeItem).not.toHaveBeenCalled();
  });

  it("opens update mode on the stored item's decrypted token", async () => {
    owner();
    admin(() => ({ data: { provider_item_id: PLAID_ITEM, access_token: encryptToken(ACCESS, PLAID_ITEM, KEY) } }));
    await expect(startUpdateMode({ itemId: "aaaaaaaa-0000-4000-8000-000000000001" })).resolves.toMatchObject({ ok: true });
    expect(provider.createLinkToken).toHaveBeenCalledWith({ userId: "owner-uid", webhookUrl: "https://hydra.example/api/plaid/webhook", accessToken: ACCESS });
  });
});

describe("importFile", () => {
  const CSV = ["Date,Description,Amount", "11/03/2026,NETFLIX.COM,-15.49", "11/04/2026,ACME PAYROLL,2500.00"].join("\n");
  const [already] = withImportHashes(ACCOUNT, parseImport("csv", CSV).rows);

  function db() {
    return owner((op) => {
      if (op.table === "accounts") return { data: { id: ACCOUNT, kind: "cash", is_manual: true, closed_at: null } };
      if (op.table === "transactions" && op.action === "select") return { data: [{ import_hash: already.hash }] };
      if (op.action === "upsert") return { data: (op.values as unknown[]).map((_, i) => ({ id: `new-${i}` })) };
      return {};
    });
  }

  it("dry run counts new rows and duplicates and writes nothing", async () => {
    const owned = db();
    const result = await importFile({ accountId: ACCOUNT, format: "csv", content: CSV, dryRun: true });
    expect(result).toMatchObject({ ok: true, data: { rows: 2, new: 1, duplicates: 1, inserted: 0, errors: [] } });
    expect(owned.ops.some((o) => o.action !== "select")).toBe(false);
    expect(mocks.processIngested).not.toHaveBeenCalled();
  });

  it("commit inserts only the new rows, idempotent on the import hash", async () => {
    const owned = db();
    const result = await importFile({ accountId: ACCOUNT, format: "csv", content: CSV, dryRun: false });
    expect(result).toMatchObject({ ok: true, data: { new: 1, duplicates: 1, inserted: 1 } });
    const write = owned.ops.find((o) => o.action === "upsert")!;
    expect(write.options).toEqual({ onConflict: "import_hash", ignoreDuplicates: true });
    expect(write.values).toEqual([
      { account_id: ACCOUNT, posted_on: "2026-11-04", amount_cents: 250000, name: "ACME PAYROLL", raw_description: "ACME PAYROLL", source: "csv", import_hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
  });

  it("applies rules, pairing and recurring detection to the rows it wrote (apply on ingest)", async () => {
    const owned = db();
    const before = Date.now();
    await importFile({ accountId: ACCOUNT, format: "csv", content: CSV, dryRun: false });
    expect(mocks.processIngested).toHaveBeenCalledTimes(1);
    const [client, since] = mocks.processIngested.mock.calls[0] as unknown as [unknown, Date];
    expect(client).toBe(owned);
    expect(since.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(mocks.detectAndSaveRecurring).toHaveBeenCalledWith(owned, "2026-11-21");
  });
});

describe("edits", () => {
  it("keeps a feed transaction's date and amount out of reach", async () => {
    const owned = owner(() => ({ data: { source: "plaid", amount_cents: -100 } }));
    await expect(editTransaction({ transactionId: TX, amountCents: -200 })).resolves.toMatchObject({ ok: false, error: { code: "not_manual" } });
    expect(owned.ops.some((o) => o.action === "update")).toBe(false);
  });

  it("marks a business picked by hand so no rule moves it again (manual wins)", async () => {
    const owned = owner((op) => (op.action === "select" ? { data: { source: "plaid", entity_id: "e-ugc" } } : { data: { id: TX } }));
    const ENTITY = "eeeeeeee-0000-4000-8000-000000000002";
    await expect(editTransaction({ transactionId: TX, entityId: ENTITY })).resolves.toEqual({
      ok: true,
      data: { transactionId: TX, before: { entity_id: "e-ugc" } },
    });
    expect(owned.ops.find((o) => o.action === "update")?.values).toEqual({ entity_id: ENTITY, entity_manual: true });
  });

  it("marks a business named on a new manual transaction so no rule moves it; none named stays open to rules", async () => {
    const ENTITY = "eeeeeeee-0000-4000-8000-000000000002";
    const reply = (op: Op) => (op.columns?.startsWith("id, kind") ? { data: { id: ACCOUNT, kind: "cash", is_manual: true, closed_at: null } } : { data: { id: TX } });
    const named = owner(reply);
    await expect(addManualTransaction({ accountId: ACCOUNT, postedOn: "2026-11-20", amountCents: -4000, name: "Adobe", entityId: ENTITY })).resolves.toEqual({ ok: true, data: { transactionId: TX } });
    expect(named.ops.find((o) => o.action === "insert")?.values).toMatchObject({ entity_id: ENTITY, entity_manual: true, source: "manual" });
    const plain = owner(reply);
    await addManualTransaction({ accountId: ACCOUNT, postedOn: "2026-11-20", amountCents: -4000, name: "Adobe" });
    expect(plain.ops.find((o) => o.action === "insert")?.values).not.toHaveProperty("entity_manual");
  });

  it("renames so the name sticks, and returns what it replaced", async () => {
    const owned = owner((op) => (op.action === "select" ? { data: { source: "plaid", name: "SQ *STARBUCKS", renamed: false } } : { data: { id: TX } }));
    await expect(editTransaction({ transactionId: TX, name: "Coffee", hidden: undefined })).resolves.toEqual({
      ok: true,
      data: { transactionId: TX, before: { name: "SQ *STARBUCKS", renamed: false } },
    });
    expect(owned.ops.find((o) => o.action === "update")?.values).toEqual({ name: "Coffee", renamed: true });
  });

  it("edits a linked account's overrides but not its name", async () => {
    owner((op) => (op.columns?.startsWith("id, kind") ? { data: { id: ACCOUNT, kind: "card", is_manual: false, closed_at: null } } : { data: { id: ACCOUNT } }));
    await expect(editAccount({ accountId: ACCOUNT, name: "Renamed" })).resolves.toMatchObject({ ok: false, error: { code: "not_manual" } });
    const owned = owner((op) =>
      op.columns?.startsWith("id, kind")
        ? { data: { id: ACCOUNT, kind: "card", is_manual: false, closed_at: null } }
        : { data: { statement_due_on_override: null } },
    );
    await expect(editAccount({ accountId: ACCOUNT, statementDueOnOverride: "2026-12-05" })).resolves.toEqual({
      ok: true,
      data: { accountId: ACCOUNT, before: { statement_due_on_override: null } },
    });
    expect(owned.ops.find((o) => o.action === "update")?.values).toEqual({ statement_due_on_override: "2026-12-05" });
  });
});
