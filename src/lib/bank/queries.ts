import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccountKind } from "./provider";

/**
 * Bank reads. Pass the signed-in client (createServerClient: RLS keeps it to the owner) or, for the
 * Hydra Agent, a client on its read role. Rows keep the database's column names.
 */

const ACCOUNT_COLUMNS =
  "id, bank_item_id, kind, entity_id, name, nickname, mask, institution, in_net_worth, is_manual, " +
  "statement_balance_cents, statement_due_on, statement_balance_override_cents, statement_due_on_override, closed_at, created_at";
const TRANSACTION_COLUMNS =
  "id, account_id, provider_transaction_id, pending, posted_on, authorized_on, amount_cents, name, renamed, merchant, " +
  "raw_description, note, entity_id, category_id, category_source, tax_line_id, is_transfer, transfer_pair_id, hidden, " +
  "recurring_id, source, created_at, updated_at";

export interface BalanceRow {
  as_of: string;
  /** Card and loan accounts: the amount owed, positive. */
  current_cents: number | null;
  available_cents: number | null;
  limit_cents: number | null;
  /** History only: walked back from the next real balance through posted transactions. */
  estimated?: boolean;
}

export interface AccountRow {
  id: string;
  bank_item_id: string | null;
  kind: AccountKind;
  entity_id: string;
  name: string;
  nickname: string | null;
  mask: string | null;
  institution: string | null;
  in_net_worth: boolean;
  is_manual: boolean;
  statement_balance_cents: number | null;
  statement_due_on: string | null;
  statement_balance_override_cents: number | null;
  statement_due_on_override: string | null;
  closed_at: string | null;
  created_at: string;
}

export interface AccountWithBalance extends AccountRow {
  /** The latest daily balance, or null when none is stored yet. */
  balance: BalanceRow | null;
  /** The owner's override wins over the feed. */
  statement_balance_effective_cents: number | null;
  statement_due_effective_on: string | null;
}

export interface TransactionRow {
  id: string;
  account_id: string;
  provider_transaction_id: string | null;
  pending: boolean;
  posted_on: string;
  authorized_on: string | null;
  /** Money in positive, money out negative. */
  amount_cents: number;
  name: string;
  renamed: boolean;
  merchant: string | null;
  raw_description: string | null;
  note: string | null;
  entity_id: string;
  category_id: string | null;
  category_source: "rule" | "manual" | "import" | "none";
  tax_line_id: string | null;
  is_transfer: boolean;
  transfer_pair_id: string | null;
  hidden: boolean;
  recurring_id: string | null;
  source: "plaid" | "csv" | "ofx" | "manual";
  created_at: string;
  updated_at: string;
}

export interface TransactionFilters {
  accountId?: string;
  entityId?: string;
  /** Inclusive YYYY-MM-DD bounds on posted_on. */
  from?: string;
  to?: string;
  search?: string;
  includeHidden?: boolean;
  page?: number;
  pageSize?: number;
}

function check<T>(what: string, result: { data: T | null; error: { message: string } | null }): T {
  if (result.error || result.data === null) throw new Error(`${what}: ${result.error?.message ?? "no data"}`);
  return result.data;
}

/** A PostgREST filter value, quoted so commas, dots and parentheses in a search stay literal. */
const quoted = (value: string) => `"${value.replace(/["\\]/g, (c) => `\\${c}`)}"`;

export async function listAccounts(
  db: SupabaseClient,
  filters: { entityId?: string; includeClosed?: boolean } = {},
): Promise<AccountWithBalance[]> {
  let query = db
    .from("accounts")
    .select(`${ACCOUNT_COLUMNS}, balances(as_of, current_cents, available_cents, limit_cents)`)
    .order("as_of", { referencedTable: "balances", ascending: false })
    .limit(1, { referencedTable: "balances" })
    .order("created_at");
  if (filters.entityId) query = query.eq("entity_id", filters.entityId);
  if (!filters.includeClosed) query = query.is("closed_at", null);
  const rows = check("list accounts", await query) as unknown as (AccountRow & { balances: BalanceRow[] })[];
  return rows.map(({ balances, ...account }) => ({
    ...account,
    balance: balances[0] ?? null,
    statement_balance_effective_cents: account.statement_balance_override_cents ?? account.statement_balance_cents,
    statement_due_effective_on: account.statement_due_on_override ?? account.statement_due_on,
  }));
}

// ponytail: offset paging; switch to keyset on (posted_on, id) if the table outgrows it.
export async function listTransactions(db: SupabaseClient, filters: TransactionFilters = {}) {
  const pageSize = Math.min(Math.max(Math.trunc(filters.pageSize ?? 50), 1), 200);
  const page = Math.max(Math.trunc(filters.page ?? 0), 0);
  let query = db
    .from("transactions")
    .select(TRANSACTION_COLUMNS, { count: "exact" })
    .order("posted_on", { ascending: false })
    .order("id", { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (filters.accountId) query = query.eq("account_id", filters.accountId);
  if (filters.entityId) query = query.eq("entity_id", filters.entityId);
  if (filters.from) query = query.gte("posted_on", filters.from);
  if (filters.to) query = query.lte("posted_on", filters.to);
  if (!filters.includeHidden) query = query.eq("hidden", false);
  const search = filters.search?.trim();
  if (search) {
    const v = quoted(`%${search}%`);
    query = query.or(`name.ilike.${v},merchant.ilike.${v},raw_description.ilike.${v},note.ilike.${v}`);
  }
  const result = await query;
  const rows = check("list transactions", result) as unknown as TransactionRow[];
  return { rows, total: result.count ?? rows.length, page, pageSize };
}

/**
 * One account's daily balances (0115 account_balance_history): the real balance where there is one,
 * else walked back from the next real balance through posted transactions (`estimated`). By default
 * from its first transaction (at most 1000 days back) to its last real balance.
 */
export async function balanceHistory(
  db: SupabaseClient,
  filters: { accountId: string; from?: string; to?: string },
): Promise<BalanceRow[]> {
  const result = await db.rpc("account_balance_history", {
    p_account_id: filters.accountId,
    p_from: filters.from ?? null,
    p_to: filters.to ?? null,
  });
  return check("balance history", result) as unknown as BalanceRow[];
}
