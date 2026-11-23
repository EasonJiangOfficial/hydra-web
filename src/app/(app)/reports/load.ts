import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadReport, loadYear, panelFigures } from "@/components/reports/load-report";
import { PANEL_ROWS, type CategoryPanelData, type ExportInput, type ExportTransaction } from "@/components/reports/model";
import type { ReportScope } from "@/lib/reports/queries";
import { listEntities } from "@/lib/entities/queries";
import { listCategories, listCategoryTaxLines, listTaxLines } from "@/lib/rules/queries";

/**
 * The Reports page's reads. Every number comes from src/lib/reports; this only picks the date ranges and
 * adds the transaction text (names, categories) for the panel and the CSV files, looked up by the row ids
 * those queries returned.
 */

export { loadReport };

const CHUNK = 100;

/** Transactions by id, in small batches (an id list is part of the URL). */
async function transactionsById(db: SupabaseClient, ids: readonly string[]) {
  const rows: { id: string; posted_on: string; name: string; merchant: string | null; amount_cents: number; entity_id: string; category_id: string | null }[] = [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  for (let i = 0; i < chunks.length; i += 6) {
    const got = await Promise.all(
      chunks.slice(i, i + 6).map(async (chunk) => {
        const { data, error } = await db.from("transactions").select("id, posted_on, name, merchant, amount_cents, entity_id, category_id").in("id", chunk);
        if (error) throw new Error(`reports transactions: ${error.message}`);
        return data ?? [];
      }),
    );
    rows.push(...got.flat());
  }
  return rows;
}

async function entityNames(db: SupabaseClient) {
  const { data, error } = await db.from("entities").select("id, name, kind, status");
  if (error) throw new Error(`reports entities: ${error.message}`);
  return data ?? [];
}

/** The transactions behind a set of row ids, as export rows, oldest first. */
async function exportTransactions(db: SupabaseClient, ids: readonly string[]): Promise<ExportTransaction[]> {
  const [rows, categories, entities] = await Promise.all([transactionsById(db, ids), listCategories(db, { includeArchived: true }), entityNames(db)]);
  const cat = new Map(categories.map((c) => [c.id, c]));
  const name = (id: string | null) => {
    const c = id ? cat.get(id) : undefined;
    if (!c) return "Uncategorized";
    const p = c.parent_id ? cat.get(c.parent_id) : undefined;
    return p ? `${p.name} / ${c.name}` : c.name;
  };
  const biz = new Map(entities.map((e) => [e.id as string, e.name as string]));
  return rows
    .map((t) => ({
      id: t.id,
      day: t.posted_on,
      name: t.name,
      payer: t.merchant?.trim() || t.name,
      category: name(t.category_id),
      business: biz.get(t.entity_id) ?? "",
      cents: t.amount_cents,
    }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
}

/** Everything the four downloads are built from. */
export async function loadExport(db: SupabaseClient, scope: ReportScope, month: string): Promise<ExportInput> {
  const [data, year, entities] = await Promise.all([loadReport(db, scope, month), loadYear(db, scope, month), listEntities(db)]);
  const [transactions, yearTransactions] = await Promise.all([exportTransactions(db, data.flow.rowIds), exportTransactions(db, year.flow.rowIds)]);
  const scopeName = scope === "all" ? "All" : entities.find((e) => e.slug === scope)?.name;
  return { data, scopeName, transactions, year: { ...year, transactions: yearTransactions } };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One category's panel: its figures for the month and the five before it, its transactions, and what can be edited. */
export async function loadPanel(db: SupabaseClient, scope: ReportScope, month: string, key: string): Promise<CategoryPanelData | null> {
  const none = key === "none-expense" || key === "none-income";
  if (!none && !uuid.test(key)) return null;
  const categories = await listCategories(db, { includeArchived: true });
  const cat = none ? undefined : categories.find((c) => c.id === key);
  if (!none && !cat) return null;
  const kind: "income" | "expense" = none ? (key === "none-income" ? "income" : "expense") : cat!.kind === "income" ? "income" : "expense";
  const id = none ? null : key;

  const { now, trend } = await panelFigures(db, scope, month, kind, id);

  const newest = now.rowIds.slice(-PANEL_ROWS);
  const editableExpense = !!cat && kind === "expense";
  const [rows, taxLines, taxMap, entities] = await Promise.all([
    transactionsById(db, newest),
    editableExpense ? listTaxLines(db) : [],
    editableExpense ? listCategoryTaxLines(db) : [],
    editableExpense ? entityNames(db) : [],
  ]);
  return {
    key,
    name: cat?.name ?? (kind === "income" ? "Uncategorized income" : "Uncategorized"),
    kind,
    editable: !!cat,
    color: cat?.color ?? null,
    cents: now.cents,
    count: now.count,
    share: now.total > 0 ? now.cents / now.total : 0,
    rowIds: now.rowIds,
    transactions: rows
      .map((t) => ({ id: t.id, day: t.posted_on, name: t.merchant?.trim() || t.name, cents: t.amount_cents }))
      .sort((a, b) => b.day.localeCompare(a.day) || b.id.localeCompare(a.id)),
    trend,
    entities: entities.filter((e) => e.kind === "business" && e.status === "active").map((e) => ({ id: e.id as string, name: e.name as string })),
    taxLines: taxLines.map((t) => ({ id: t.id, label: `${t.code}  ${t.name}` })),
    taxMap: Object.fromEntries(taxMap.filter((m) => m.category_id === key).map((m) => [m.entity_id, m.tax_line_id])),
    mergeTargets: categories.filter((c) => !c.archived && c.parent_id === null && c.kind === cat?.kind && c.id !== key).map((c) => ({ id: c.id, name: c.name })),
  };
}
