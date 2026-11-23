"use server";

import { z } from "zod";

import { PAGE_SIZE, TX_COLUMNS, type RowFilters, type TransferSuggestion, type TxRow } from "@/components/transactions/types";
import { addDays } from "@/lib/planning/dates";
import { transferSuggestions as findSuggestions } from "@/lib/rules/engine";
import { reviewQueue } from "@/lib/rules/queries";
import { createServerClient } from "@/lib/supabase/server";

/**
 * The Transactions page's reads, as server functions the table calls while it scrolls and filters.
 * They run as the signed-in owner (RLS: anyone else reads nothing). Writes are the engines' own
 * actions (src/lib/rules/actions, src/lib/bank/actions, src/lib/ugc/actions), never here.
 * ponytail: offset paging, as in src/lib/bank/queries.ts; keyset on (posted_on, id) if the table outgrows it.
 */

const id = z.guid();
const day = z.iso.date();
const filtersSchema = z.object({
  q: z.string().max(200).optional(),
  accountId: id.optional(),
  entityId: id.optional(),
  categoryIds: z.array(id).max(60).optional(),
  from: day.optional(),
  to: day.optional(),
  review: z.boolean().optional(),
  hidden: z.boolean().optional(),
});

/** A PostgREST filter value, quoted so commas, dots and parentheses in a search stay literal. */
const quoted = (value: string) => `"${value.replace(/["\\]/g, (c) => `\\${c}`)}"`;

export async function listRows(filters: RowFilters, offset: number): Promise<{ rows: TxRow[]; total: number }> {
  const f = filtersSchema.parse(filters);
  const from = z.int().min(0).max(1_000_000).parse(offset);
  const db = await createServerClient();
  let query = db
    .from("transactions")
    .select(TX_COLUMNS, { count: "exact" })
    .eq("hidden", f.hidden === true)
    .order("posted_on", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);
  if (f.review && !f.hidden) query = query.is("category_id", null).eq("is_transfer", false);
  if (f.accountId) query = query.eq("account_id", f.accountId);
  if (f.entityId) query = query.eq("entity_id", f.entityId);
  if (f.categoryIds) query = query.in("category_id", f.categoryIds);
  if (f.from) query = query.gte("posted_on", f.from);
  if (f.to) query = query.lte("posted_on", f.to);
  const search = f.q?.trim();
  if (search) {
    const v = quoted(`%${search}%`);
    query = query.or(`name.ilike.${v},merchant.ilike.${v},raw_description.ilike.${v},note.ilike.${v}`);
  }
  const { data, error, count } = await query;
  if (error || !data) throw new Error(`list transactions: ${error?.message ?? "no data"}`);
  return { rows: data as unknown as TxRow[], total: count ?? data.length };
}

export async function getRow(rowId: string): Promise<TxRow | null> {
  const db = await createServerClient();
  const { data, error } = await db.from("transactions").select(TX_COLUMNS).eq("id", id.parse(rowId)).maybeSingle();
  if (error) throw new Error(`transaction: ${error.message}`);
  return (data as unknown as TxRow | null) ?? null;
}

export async function reviewCount(entityId?: string): Promise<number> {
  const db = await createServerClient();
  return (await reviewQueue(db, { entityId: entityId ? id.parse(entityId) : undefined, pageSize: 1 })).total;
}

/** Rows that could be the other half of a transfer or card payment: same amount, other sign, another account, within 5 days. */
export async function pairCandidates(rowId: string): Promise<TxRow[]> {
  const row = await getRow(rowId);
  if (!row || row.transfer_pair_id) return [];
  const db = await createServerClient();
  const { data, error } = await db
    .from("transactions")
    .select(TX_COLUMNS)
    .eq("amount_cents", -row.amount_cents)
    .neq("account_id", row.account_id)
    .neq("id", row.id)
    .is("transfer_pair_id", null)
    .gte("posted_on", addDays(row.posted_on, -5))
    .lte("posted_on", addDays(row.posted_on, 5))
    .order("posted_on", { ascending: false })
    .limit(20);
  if (error) throw new Error(`pair candidates: ${error.message}`);
  return (data ?? []) as unknown as TxRow[];
}

export async function dealPayment(rowId: string): Promise<{ deal_id: string } | null> {
  const db = await createServerClient();
  const { data, error } = await db.from("deal_payments").select("deal_id").eq("transaction_id", id.parse(rowId)).maybeSingle();
  if (error) throw new Error(`deal payment: ${error.message}`);
  return (data as { deal_id: string } | null) ?? null;
}

/** Possible transfers between two cash accounts, for Needs review: never paired until the owner says so. */
export async function transferSuggestions(): Promise<TransferSuggestion[]> {
  const db = await createServerClient();
  const pairs = await findSuggestions(db);
  if (!pairs.length) return [];
  const { data, error } = await db.from("transactions").select(TX_COLUMNS).in("id", pairs.flatMap((p) => [p.a, p.b]));
  if (error) throw new Error(`transfer suggestions: ${error.message}`);
  const rows = new Map(((data ?? []) as unknown as TxRow[]).map((r) => [r.id, r]));
  return pairs.flatMap((p) => {
    const out = rows.get(p.a);
    const into = rows.get(p.b);
    return out && into ? [{ out, into }] : [];
  });
}
