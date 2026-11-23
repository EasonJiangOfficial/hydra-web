import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKind } from "@/lib/ledger/totals";
import { priceChangeFlagged, type PriceChange } from "@/lib/recurring/detect";
import { loadRules } from "./engine";

/**
 * Money-rule reads. Pass the signed-in client (RLS keeps it to the owner) or, for the Hydra Agent,
 * a client on its read role. Rows keep the database's column names.
 */

export interface ReviewRow {
  id: string;
  account_id: string;
  posted_on: string;
  amount_cents: number;
  name: string;
  merchant: string | null;
  note: string | null;
  entity_id: string;
  pending: boolean;
}

export interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
  kind: CategoryKind;
  entity_id: string | null;
  color: string | null;
  archived: boolean;
}

export interface TaxLineRow {
  id: string;
  schedule: string;
  part: string;
  code: string;
  name: string;
  position: number;
}

export interface RecurringSeriesRow {
  id: string;
  name_key: string;
  name: string;
  average_amount_cents: number;
  gap_days: number;
  last_seen_on: string;
  next_expected_on: string;
  status: "suggested" | "confirmed" | "dismissed";
  last_price_change: PriceChange | null;
  /** The newest charge changed the price. */
  price_change_flagged: boolean;
}

function check<T>(what: string, result: { data: T | null; error: { message: string } | null }): T {
  if (result.error || result.data === null) throw new Error(`${what}: ${result.error?.message ?? "no data"}`);
  return result.data;
}

/** "Needs review": rows with no category that are not transfers or hidden, newest first. */
export async function reviewQueue(
  db: SupabaseClient,
  filters: { entityId?: string; page?: number; pageSize?: number } = {},
): Promise<{ rows: ReviewRow[]; total: number }> {
  const pageSize = Math.min(Math.max(Math.trunc(filters.pageSize ?? 50), 1), 200);
  const page = Math.max(Math.trunc(filters.page ?? 0), 0);
  let query = db
    .from("transactions")
    .select("id, account_id, posted_on, amount_cents, name, merchant, note, entity_id, pending", { count: "exact" })
    .is("category_id", null)
    .eq("is_transfer", false)
    .eq("hidden", false)
    .order("posted_on", { ascending: false })
    .order("id", { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (filters.entityId) query = query.eq("entity_id", filters.entityId);
  const result = await query;
  const rows = check("review queue", result) as unknown as ReviewRow[];
  return { rows, total: result.count ?? rows.length };
}

/** Rules in the order they run. */
export const listRules = loadRules;

export async function listRecurring(
  db: SupabaseClient,
  filters: { status?: RecurringSeriesRow["status"] } = {},
): Promise<RecurringSeriesRow[]> {
  let query = db
    .from("recurring")
    .select("id, name_key, name, average_amount_cents, gap_days, last_seen_on, next_expected_on, status, last_price_change")
    .order("next_expected_on");
  if (filters.status) query = query.eq("status", filters.status);
  const rows = check("list recurring", await query) as unknown as Omit<RecurringSeriesRow, "price_change_flagged">[];
  return rows.map((r) => ({ ...r, price_change_flagged: priceChangeFlagged(r) }));
}

export async function listCategories(db: SupabaseClient, filters: { includeArchived?: boolean } = {}): Promise<CategoryRow[]> {
  let query = db.from("categories").select("id, name, parent_id, kind, entity_id, color, archived").order("name");
  if (!filters.includeArchived) query = query.eq("archived", false);
  return check("list categories", await query) as unknown as CategoryRow[];
}

export async function listTaxLines(db: SupabaseClient): Promise<TaxLineRow[]> {
  return check("list tax lines", await db.from("tax_lines").select("id, schedule, part, code, name, position").order("position")) as unknown as TaxLineRow[];
}

/** The category to tax line map: one line per category per entity. */
export async function listCategoryTaxLines(
  db: SupabaseClient,
): Promise<{ category_id: string; entity_id: string; tax_line_id: string }[]> {
  return check("list category tax lines", await db.from("category_tax_lines").select("category_id, entity_id, tax_line_id")) as unknown as {
    category_id: string;
    entity_id: string;
    tax_line_id: string;
  }[];
}
