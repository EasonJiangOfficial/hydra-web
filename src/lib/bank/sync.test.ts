// @vitest-environment node
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encryptToken } from "./crypto";
import { defaultRoutes, fixtures, plaidFetch, sandboxConfig } from "./fixtures/plaid-fetch";
import { createPlaidProvider } from "./plaid";
import {
  BankProviderError,
  MUTATION_DURING_PAGINATION,
  type BankProvider,
  type CardStatement,
  type ProviderTransaction,
  type SyncPage,
} from "./provider";
import { runBankCron } from "./cron";
import { afterEachPage, dayIn, supabaseSyncStore, syncItem, type ApplyPageInput, type SyncItemRow, type SyncStore } from "./sync";

/**
 * The sync engine's write-path guards. MemoryStore keeps the contract of
 * public.bank_apply_sync_page (cursor compare-and-set under a per-item lock, upsert on the provider
 * id, pending-to-posted takeover, removals last); supabase/tests/0020_bank.test.sql proves the SQL
 * itself on Postgres.
 */

const KEY = randomBytes(32);
const ITEM = fixtures.itemPublicTokenExchange.item_id;
const ACCESS = fixtures.itemPublicTokenExchange.access_token;
const NOW = new Date("2026-11-21T03:30:00Z");

type Row = ProviderTransaction & { note: string | null };

class MemoryStore implements SyncStore {
  item: SyncItemRow & { lastError: string | null; status: string };
  rows = new Map<string, Row>();
  cards: CardStatement[] = [];
  log: { expected: string | null; next: string; result: "applied" | "conflict" }[] = [];
  dieAfterCommit = false;
  private lock: Promise<unknown> = Promise.resolve();

  constructor() {
    vi.stubEnv("HYDRA_TOKEN_KEY", KEY.toString("base64"));
    this.item = { id: "item-1", providerItemId: ITEM, accessToken: encryptToken(ACCESS, ITEM), cursor: null, anchor: null, lastError: null, status: "active" };
  }

  async loadItem() {
    await Promise.resolve();
    return { ...this.item };
  }

  applyPage(input: ApplyPageInput) {
    const run = this.lock.then(() => this.apply(input));
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async apply({ expectedCursor, nextCursor, hasMore, page }: ApplyPageInput): Promise<"applied" | "conflict"> {
    await Promise.resolve();
    if (this.item.cursor !== expectedCursor) {
      this.log.push({ expected: expectedCursor, next: nextCursor, result: "conflict" });
      return "conflict";
    }
    for (const t of [...(page?.added ?? []), ...(page?.modified ?? [])]) {
      const pending = t.pendingTransactionId ? this.rows.get(t.pendingTransactionId) : undefined;
      if (pending && !this.rows.has(t.providerTransactionId)) {
        this.rows.delete(t.pendingTransactionId!);
        this.rows.set(t.providerTransactionId, pending);
      }
      this.rows.set(t.providerTransactionId, { ...t, note: this.rows.get(t.providerTransactionId)?.note ?? null });
    }
    page?.removed.forEach((r) => this.rows.delete(r.providerTransactionId));
    this.item.anchor = hasMore ? (this.item.anchor ?? expectedCursor ?? "") : null;
    this.item.cursor = nextCursor;
    this.item.lastError = null;
    this.log.push({ expected: expectedCursor, next: nextCursor, result: "applied" });
    if (this.dieAfterCommit) {
      this.dieAfterCommit = false;
      throw new Error("connection reset after commit");
    }
    return "applied";
  }

  async setCardStatements(_itemId: string, cards: CardStatement[]) {
    this.cards = cards;
  }

  async recordError(_itemId: string, code: string, status?: string) {
    this.item.lastError = code;
    if (status) this.item.status = status;
  }
}

const tx = (id: string, o: Partial<ProviderTransaction> = {}): ProviderTransaction => ({
  providerAccountId: "acc-1",
  providerTransactionId: id,
  pending: false,
  pendingTransactionId: null,
  postedOn: "2026-11-20",
  authorizedOn: null,
  amountCents: -100,
  name: id,
  merchant: null,
  rawDescription: null,
  ...o,
});

const page = (added: ProviderTransaction[], nextCursor: string, hasMore: boolean, o: Partial<SyncPage> = {}): SyncPage => ({
  accounts: [{ providerAccountId: "acc-1", name: "Checking", mask: "0000", kind: "cash", currentCents: 1000, availableCents: 900, limitCents: null }],
  added,
  modified: [],
  removed: [],
  nextCursor,
  hasMore,
  ...o,
});

/** Pages keyed by the cursor they answer ("" = first page). */
function scripted(pages: Record<string, SyncPage>, before?: (cursor: string, call: number) => Promise<void> | void): BankProvider & { asked: string[] } {
  const asked: string[] = [];
  const fail = () => {
    throw new Error("not used");
  };
  return {
    name: "plaid",
    asked,
    async syncTransactions(_token, cursor) {
      const key = cursor ?? "";
      asked.push(key);
      await before?.(key, asked.length);
      const p = pages[key];
      if (!p) throw new Error(`no page for cursor "${key}"`);
      return p;
    },
    getCardStatements: async () => [],
    createLinkToken: fail,
    exchangePublicToken: fail,
    getBalances: fail,
    verifyWebhook: fail,
    removeItem: fail,
  };
}

const PAGES = {
  "": page([tx("t1"), tx("t2")], "c1", true),
  c1: page([tx("t3")], "c2", false),
};
const sync = (store: MemoryStore, provider: BankProvider) => syncItem("item-1", { store, provider, timeZone: "America/New_York", now: () => NOW });

describe("syncItem write paths", () => {
  it("two syncs at once: one writes each page, the other stops with conflict and writes nothing", async () => {
    const store = new MemoryStore();
    let release!: () => void;
    const bothFetching = new Promise<void>((r) => (release = r));
    let firstPageCalls = 0;
    const provider = scripted(PAGES, async (cursor) => {
      if (cursor !== "") return;
      if (++firstPageCalls === 2) release();
      await bothFetching; // both runs hold the same old cursor before either writes
    });

    const results = await Promise.all([sync(store, provider), sync(store, provider)]);

    expect(results.map((r) => r.status).sort()).toEqual(["conflict", "synced"]);
    expect(store.log).toEqual([
      { expected: null, next: "c1", result: "applied" },
      { expected: null, next: "c1", result: "conflict" },
      { expected: "c1", next: "c2", result: "applied" },
    ]);
    expect([...store.rows.keys()].sort()).toEqual(["t1", "t2", "t3"]);
    expect(store.item.cursor).toBe("c2");
  });

  it("death between pages: the next run resumes from the last written page", async () => {
    const store = new MemoryStore();
    const dying = scripted(PAGES, (cursor) => {
      if (cursor === "c1") throw new Error("lambda killed");
    });
    await expect(sync(store, dying)).rejects.toThrow("lambda killed");
    expect(store.item).toMatchObject({ cursor: "c1", anchor: "" });
    expect([...store.rows.keys()]).toEqual(["t1", "t2"]);

    const healthy = scripted(PAGES);
    await expect(sync(store, healthy)).resolves.toEqual({ status: "synced", pages: 1, added: 1, modified: 0, removed: 0 });
    expect(healthy.asked).toEqual(["c1"]);
    expect([...store.rows.keys()].sort()).toEqual(["t1", "t2", "t3"]);
    expect(store.item).toMatchObject({ cursor: "c2", anchor: null });
  });

  it("retry after partial success: a page committed before the reply was lost is not pulled or written twice", async () => {
    const store = new MemoryStore();
    store.dieAfterCommit = true;
    await expect(sync(store, scripted(PAGES))).rejects.toThrow("connection reset after commit");
    const retry = scripted(PAGES);
    await expect(sync(store, retry)).resolves.toMatchObject({ status: "synced", pages: 1 });
    expect(retry.asked).toEqual(["c1"]);
    expect(store.log.map((l) => `${l.expected}->${l.next}`)).toEqual(["null->c1", "c1->c2"]);
    expect(store.rows.size).toBe(3);
  });

  it("retry after partial success: a mid-loop mutation rewinds to the loop's first cursor; replayed rows upsert", async () => {
    const store = new MemoryStore();
    let mutated = false;
    const provider = scripted(PAGES, (cursor) => {
      if (cursor === "c1" && !mutated) {
        mutated = true;
        throw new BankProviderError(MUTATION_DURING_PAGINATION, 400);
      }
    });
    await expect(sync(store, provider)).resolves.toEqual({ status: "synced", pages: 3, added: 5, modified: 0, removed: 0 });
    expect(provider.asked).toEqual(["", "c1", "", "c1"]);
    expect(store.log.map((l) => `${l.expected}->${l.next}`)).toEqual(["null->c1", "c1->", "->c1", "c1->c2"]);
    expect([...store.rows.keys()].sort()).toEqual(["t1", "t2", "t3"]);
    expect(store.item).toMatchObject({ cursor: "c2", anchor: null });
  });

  it("stops after three rewinds in a row", async () => {
    const store = new MemoryStore();
    const provider = scripted(PAGES, (cursor) => {
      if (cursor === "c1") throw new BankProviderError(MUTATION_DURING_PAGINATION, 400);
    });
    await expect(sync(store, provider)).resolves.toMatchObject({ status: "error", code: MUTATION_DURING_PAGINATION });
    expect(store.item.lastError).toBe(MUTATION_DURING_PAGINATION);
  });

  it("pending to posted: one row, keyed by the posted id, the owner's note kept (real adapter on Plaid fixtures)", async () => {
    const store = new MemoryStore();
    const pendingId = fixtures.syncPage1.added[1].transaction_id;
    const postedId = fixtures.syncPage2.added[0].transaction_id;
    const routes = defaultRoutes();
    const plain = routes["/transactions/sync"] as (body: Record<string, unknown>, n: number) => { body: unknown };
    routes["/transactions/sync"] = (body, n) => {
      if (body.cursor) store.rows.get(pendingId)!.note = "team coffee"; // the owner edits between pages
      return plain(body, n);
    };
    const { fetchFn } = plaidFetch(routes);
    const provider = createPlaidProvider({ config: sandboxConfig, fetch: fetchFn });

    const result = await sync(store, provider);

    console.log(`[sandbox fixtures] synced ${JSON.stringify(result)}`);
    expect(result).toEqual({ status: "synced", pages: 2, added: 4, modified: 1, removed: 1 });
    expect(store.rows.has(pendingId)).toBe(false);
    expect(store.rows.get(postedId)).toMatchObject({ pending: false, pendingTransactionId: pendingId, amountCents: -473, note: "team coffee" });
    expect(store.rows.size).toBe(3);
    expect(store.cards).toEqual([{ providerAccountId: fixtures.liabilitiesGet.liabilities.credit[0].account_id, statementBalanceCents: 170877, dueOn: "2026-11-28" }]);
  });

  it("marks the item for update mode when the bank wants a new login", async () => {
    const store = new MemoryStore();
    const { fetchFn } = plaidFetch({ ...defaultRoutes(), "/transactions/sync": { status: 400, body: fixtures.errorItemLoginRequired } });
    const result = await sync(store, createPlaidProvider({ config: sandboxConfig, fetch: fetchFn }));
    expect(result).toEqual({ status: "error", pages: 0, code: "ITEM_LOGIN_REQUIRED" });
    expect(store.item).toMatchObject({ status: "login_required", lastError: "ITEM_LOGIN_REQUIRED", cursor: null });
  });

  it("refuses a tampered token without calling the bank", async () => {
    const store = new MemoryStore();
    store.item.accessToken = store.item.accessToken.slice(0, -2) + (store.item.accessToken.endsWith("A") ? "BB" : "AA");
    const provider = scripted(PAGES);
    await expect(sync(store, provider)).resolves.toEqual({ status: "error", pages: 0, code: "TOKEN_DECRYPT_FAILED" });
    expect(provider.asked).toEqual([]);
  });

  it("reports an unknown item", async () => {
    const store = new MemoryStore();
    store.loadItem = async () => null as unknown as SyncItemRow & { lastError: string | null; status: string };
    await expect(sync(store, scripted(PAGES))).resolves.toEqual({ status: "error", pages: 0, code: "ITEM_NOT_FOUND" });
  });
});

describe("dayIn", () => {
  it("uses the owner's calendar day, across midnight and DST", () => {
    expect(dayIn("America/New_York", NOW)).toBe("2026-11-20");
    expect(dayIn("UTC", NOW)).toBe("2026-11-21");
    expect(dayIn("America/New_York", new Date("2026-03-08T06:59:00Z"))).toBe("2026-03-08");
    expect(dayIn("America/Los_Angeles", new Date("2026-12-01T07:59:00Z"))).toBe("2026-11-30");
  });
});

describe("supabaseSyncStore", () => {
  it("sends one page to bank_apply_sync_page in the database's shape", async () => {
    const rpc = vi.fn(async () => ({ data: "applied", error: null }));
    const store = supabaseSyncStore({ rpc } as never);
    const posted = tx("posted", { pendingTransactionId: "pending", amountCents: -473 });
    await expect(
      store.applyPage({ itemId: "item-1", expectedCursor: null, nextCursor: "c1", hasMore: true, asOf: "2026-11-20", startedAt: NOW, page: page([posted], "c1", true, { removed: [{ providerTransactionId: "pending" }] }) }),
    ).resolves.toBe("applied");
    expect(rpc).toHaveBeenCalledWith("bank_apply_sync_page", {
      p_item_id: "item-1",
      p_expected_cursor: null,
      p_next_cursor: "c1",
      p_has_more: true,
      p_as_of: "2026-11-20",
      p_started_at: NOW.toISOString(),
      p_accounts: [{ provider_account_id: "acc-1", name: "Checking", mask: "0000", kind: "cash", current_cents: 1000, available_cents: 900, limit_cents: null }],
      p_added: [
        {
          provider_account_id: "acc-1",
          provider_transaction_id: "posted",
          pending: false,
          pending_transaction_id: "pending",
          posted_on: "2026-11-20",
          authorized_on: null,
          amount_cents: -473,
          name: "posted",
          merchant: null,
          raw_description: null,
        },
      ],
      p_modified: [],
      p_removed: [{ provider_transaction_id: "pending" }],
    });
  });

  it("passes conflict through and fails loudly on anything else", async () => {
    const conflict = supabaseSyncStore({ rpc: async () => ({ data: "conflict", error: null }) } as never);
    await expect(conflict.applyPage({ itemId: "i", expectedCursor: "x", nextCursor: "y", hasMore: false, asOf: "2026-11-20", startedAt: NOW })).resolves.toBe("conflict");
    const broken = supabaseSyncStore({ rpc: async () => ({ data: null, error: { message: "permission denied" } }) } as never);
    await expect(broken.applyPage({ itemId: "i", expectedCursor: "x", nextCursor: "y", hasMore: false, asOf: "2026-11-20", startedAt: NOW })).rejects.toThrow("permission denied");
  });
});

describe("apply on ingest and the daily sweep", () => {
  it("runs the ingest step after each page of rows lands, never after a conflict", async () => {
    const store = new MemoryStore();
    const pages: string[] = [];
    const ingesting = afterEachPage(store, async (input) => {
      pages.push(input.nextCursor);
      expect(input.startedAt).toEqual(NOW);
    });
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    let calls = 0;
    const provider = scripted(PAGES, async (cursor) => {
      if (cursor === "" && ++calls === 2) release();
      if (cursor === "") await both;
    });
    const results = await Promise.all([syncItem("item-1", { store: ingesting, provider, timeZone: "UTC", now: () => NOW }), syncItem("item-1", { store: ingesting, provider, timeZone: "UTC", now: () => NOW })]);
    expect(results.map((r) => r.status).sort()).toEqual(["conflict", "synced"]);
    expect(pages).toEqual(["c1", "c2"]);
  });

  it("two sweeps at once: each page is written once, every item is tried, and rules and recurring run after", async () => {
    const store = new MemoryStore();
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    let calls = 0;
    const provider = scripted(PAGES, async (cursor) => {
      if (cursor === "" && ++calls === 2) release();
      if (cursor === "") await both;
    });
    const ingested: string[] = [];
    const cron = () =>
      runBankCron({
        listItems: async () => [{ id: "item-1" }, { id: "item-gone" }],
        sync: async (id) => {
          if (id === "item-gone") throw new Error("boom");
          return syncItem(id, { store: afterEachPage(store, async (i) => void ingested.push(i.nextCursor)), provider, timeZone: "UTC", now: () => NOW });
        },
        processIngested: async (since) => {
          expect(since.toISOString()).toBe("2026-11-19T15:30:00.000Z"); // 36 hours back
          return { checked: 3, changed: 0, paired: 0 };
        },
        detectRecurring: async () => ({ found: 0, saved: 0 }),
        now: NOW,
      });

    const [a, b] = await Promise.all([cron(), cron()]);

    expect([a.items[0]!.status, b.items[0]!.status].sort()).toEqual(["conflict", "synced"]);
    expect(a.items[1]).toEqual({ itemId: "item-gone", status: "failed", message: "boom" });
    expect(store.log.filter((l) => l.result === "applied").map((l) => l.next)).toEqual(["c1", "c2"]);
    expect([...store.rows.keys()].sort()).toEqual(["t1", "t2", "t3"]);
    expect(ingested).toEqual(["c1", "c2"]);
    expect(a.recurring).toEqual({ found: 0, saved: 0 });
  });
});
