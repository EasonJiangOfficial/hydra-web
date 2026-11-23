import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptToken, TokenDecryptError } from "./crypto";
import {
  BankProviderError,
  ITEM_LOGIN_REQUIRED,
  MUTATION_DURING_PAGINATION,
  type BankProvider,
  type CardStatement,
  type ItemStatus,
  type ProviderAccount,
  type ProviderTransaction,
  type SyncPage,
} from "./provider";

/**
 * Sync one bank item: pull pages from the provider, write each page and its cursor in one database
 * transaction (public.bank_apply_sync_page), then card statements.
 * - Two syncs at once: the database's cursor compare-and-set picks one; the other stops with 'conflict'.
 * - Death between pages: the cursor of the last written page is stored; the next run resumes there.
 * - Plaid TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION: rewind to the loop's first cursor and pull
 *   again; rows already written upsert on their provider id, so nothing doubles.
 */

export interface SyncItemRow {
  id: string;
  providerItemId: string;
  /** Sealed (./crypto.ts). */
  accessToken: string;
  cursor: string | null;
  /** The cursor the open pagination loop started from; null when no loop is open. */
  anchor: string | null;
}

export interface ApplyPageInput {
  itemId: string;
  expectedCursor: string | null;
  nextCursor: string;
  hasMore: boolean;
  asOf: string;
  startedAt: Date;
  page?: Pick<SyncPage, "accounts" | "added" | "modified" | "removed">;
}

export interface SyncStore {
  loadItem(itemId: string): Promise<SyncItemRow | null>;
  applyPage(input: ApplyPageInput): Promise<"applied" | "conflict">;
  setCardStatements(itemId: string, cards: CardStatement[]): Promise<void>;
  recordError(itemId: string, code: string, status?: ItemStatus): Promise<void>;
}

export type SyncResult =
  | { status: "synced"; pages: number; added: number; modified: number; removed: number }
  | { status: "conflict"; pages: number }
  | { status: "error"; pages: number; code: string };

const MAX_RESTARTS = 3;

/** The calendar day of `at` in `timeZone`, as YYYY-MM-DD. */
export function dayIn(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export async function syncItem(
  itemId: string,
  deps: { store: SyncStore; provider: BankProvider; timeZone: string; now?: () => Date },
): Promise<SyncResult> {
  const { store, provider } = deps;
  const item = await store.loadItem(itemId);
  if (!item) return { status: "error", pages: 0, code: "ITEM_NOT_FOUND" };

  let accessToken: string;
  try {
    accessToken = decryptToken(item.accessToken, item.providerItemId);
  } catch (error) {
    if (!(error instanceof TokenDecryptError)) throw error;
    await store.recordError(itemId, "TOKEN_DECRYPT_FAILED", "error");
    return { status: "error", pages: 0, code: "TOKEN_DECRYPT_FAILED" };
  }

  const startedAt = (deps.now ?? (() => new Date()))();
  const asOf = dayIn(deps.timeZone, startedAt);
  const anchor = item.anchor ?? item.cursor ?? "";
  let cursor = item.cursor;
  let restarts = 0;
  let hasCard = false;
  const totals = { pages: 0, added: 0, modified: 0, removed: 0 };

  for (;;) {
    let page: SyncPage;
    try {
      page = await provider.syncTransactions(accessToken, cursor);
    } catch (error) {
      if (!(error instanceof BankProviderError)) throw error;
      if (error.code === MUTATION_DURING_PAGINATION && restarts < MAX_RESTARTS) {
        restarts++;
        if ((cursor ?? "") !== anchor) {
          const rewound = await store.applyPage({ itemId, expectedCursor: cursor, nextCursor: anchor, hasMore: true, asOf, startedAt });
          if (rewound === "conflict") return { status: "conflict", pages: totals.pages };
          cursor = anchor;
        }
        continue;
      }
      await store.recordError(itemId, error.code, error.code === ITEM_LOGIN_REQUIRED ? "login_required" : undefined);
      return { status: "error", pages: totals.pages, code: error.code };
    }

    const result = await store.applyPage({
      itemId,
      expectedCursor: cursor,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      asOf,
      startedAt,
      page,
    });
    if (result === "conflict") return { status: "conflict", pages: totals.pages };
    totals.pages++;
    totals.added += page.added.length;
    totals.modified += page.modified.length;
    totals.removed += page.removed.length;
    hasCard ||= page.accounts.some((a) => a.kind === "card");
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }

  // Asked only when the item has a card, so Liabilities is never added to an item that has none.
  if (hasCard) {
    try {
      await store.setCardStatements(itemId, await provider.getCardStatements(accessToken));
    } catch (error) {
      if (!(error instanceof BankProviderError)) throw error;
      await store.recordError(itemId, error.code);
    }
  }
  return { status: "synced", ...totals };
}

/** `store`, calling `onPage` after each page of rows lands (not after a rewind or a conflict). */
export function afterEachPage(store: SyncStore, onPage: (input: ApplyPageInput) => Promise<void>): SyncStore {
  return {
    loadItem: (itemId) => store.loadItem(itemId),
    setCardStatements: (itemId, cards) => store.setCardStatements(itemId, cards),
    recordError: (itemId, code, status) => store.recordError(itemId, code, status),
    async applyPage(input) {
      const result = await store.applyPage(input);
      if (result === "applied" && input.page) await onPage(input);
      return result;
    },
  };
}

const accountRow = (a: ProviderAccount) => ({
  provider_account_id: a.providerAccountId,
  name: a.name,
  mask: a.mask,
  kind: a.kind,
  current_cents: a.currentCents,
  available_cents: a.availableCents,
  limit_cents: a.limitCents,
});

const transactionRow = (t: ProviderTransaction) => ({
  provider_account_id: t.providerAccountId,
  provider_transaction_id: t.providerTransactionId,
  pending: t.pending,
  pending_transaction_id: t.pendingTransactionId,
  posted_on: t.postedOn,
  authorized_on: t.authorizedOn,
  amount_cents: t.amountCents,
  name: t.name,
  merchant: t.merchant,
  raw_description: t.rawDescription,
});

/** The store on Supabase. `db` must be the service-role client: the token and cursor are hidden from every other role. */
export function supabaseSyncStore(db: SupabaseClient): SyncStore {
  const fail = (what: string, error: { message: string }) => new Error(`${what}: ${error.message}`);
  return {
    async loadItem(itemId) {
      const { data, error } = await db
        .from("bank_items")
        .select("id, provider_item_id, access_token, cursor, sync_anchor_cursor")
        .eq("id", itemId)
        .maybeSingle();
      if (error) throw fail("load bank item", error);
      return (
        data && {
          id: data.id,
          providerItemId: data.provider_item_id,
          accessToken: data.access_token,
          cursor: data.cursor,
          anchor: data.sync_anchor_cursor,
        }
      );
    },

    async applyPage({ itemId, expectedCursor, nextCursor, hasMore, asOf, startedAt, page }) {
      const { data, error } = await db.rpc("bank_apply_sync_page", {
        p_item_id: itemId,
        p_expected_cursor: expectedCursor,
        p_next_cursor: nextCursor,
        p_has_more: hasMore,
        p_as_of: asOf,
        p_started_at: startedAt.toISOString(),
        p_accounts: (page?.accounts ?? []).map(accountRow),
        p_added: (page?.added ?? []).map(transactionRow),
        p_modified: (page?.modified ?? []).map(transactionRow),
        p_removed: (page?.removed ?? []).map((r) => ({ provider_transaction_id: r.providerTransactionId })),
      });
      if (error) throw fail("apply sync page", error);
      if (data !== "applied" && data !== "conflict") throw new Error(`apply sync page: unexpected result ${String(data)}`);
      return data;
    },

    async setCardStatements(itemId, cards) {
      for (const card of cards) {
        const { error } = await db
          .from("accounts")
          .update({ statement_balance_cents: card.statementBalanceCents, statement_due_on: card.dueOn })
          .eq("bank_item_id", itemId)
          .eq("provider_account_id", card.providerAccountId);
        if (error) throw fail("set card statement", error);
      }
    },

    async recordError(itemId, code, status) {
      const { error } = await db
        .from("bank_items")
        .update({ last_error: code, ...(status ? { status } : {}) })
        .eq("id", itemId);
      if (error) throw fail("record bank error", error);
    },
  };
}
