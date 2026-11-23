import type { SupabaseClient } from "@supabase/supabase-js";
import { loadReport, loadYear, panelFigures } from "@/components/reports/load-report";
import {
  PANEL_ROWS,
  shiftMonth,
  type CategoryPanelData,
  type ExportInput,
  type ExportTransaction,
  type PanelResult,
  type ReportsActions,
} from "@/components/reports/model";
import type { ReportScope } from "@/lib/reports/queries";

/**
 * The /dev/reports data: eleven months of transactions in memory, and a stand-in for the database's
 * `rpc` that answers the six report functions the way supabase/migrations/0050_reports.sql does. The page
 * runs the real src/lib/reports queries over it, so the fixture and the live page shape numbers with the
 * same code. Fixed clock: today is Saturday, November 21, 2026.
 */

export const TODAY = "2026-11-21";
export const FIRST_MONTH = "2026-11";

const g = (kind: string, n: number) => `${kind}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const E = { personal: g("e", 1), ugc: g("e", 2) } as const;
const C = (n: number) => g("c", n);
const TL = (n: number) => g("a", n);

export interface FxCategory {
  id: string;
  name: string;
  kind: "income" | "expense" | "transfer";
  parentId: string | null;
  color: string | null;
}
export interface FxTx {
  id: string;
  day: string;
  name: string;
  merchant: string | null;
  cents: number;
  entity: "personal" | "ugc";
  categoryId: string | null;
  hidden?: boolean;
  transfer?: boolean;
}
export interface FxDb {
  categories: FxCategory[];
  transactions: FxTx[];
  taxLines: { id: string; code: string; name: string; position: number }[];
  /** `${categoryId}|${entityId}` to tax line id. */
  taxMap: Record<string, string>;
}

const CATEGORIES: FxCategory[] = [
  { id: C(1), name: "Wordwise", kind: "income", parentId: null, color: null },
  { id: C(2), name: "Brightleaf", kind: "income", parentId: null, color: null },
  { id: C(3), name: "Other income", kind: "income", parentId: null, color: null },
  { id: C(10), name: "Housing", kind: "expense", parentId: null, color: null },
  { id: C(11), name: "Taxes", kind: "expense", parentId: null, color: null },
  { id: C(12), name: "Food", kind: "expense", parentId: null, color: null },
  { id: C(13), name: "Software", kind: "expense", parentId: null, color: null },
  { id: C(14), name: "Shopping", kind: "expense", parentId: null, color: null },
  { id: C(15), name: "Other", kind: "expense", parentId: null, color: null },
  { id: C(16), name: "Transport", kind: "expense", parentId: null, color: null },
  { id: C(17), name: "Groceries", kind: "expense", parentId: C(12), color: null },
  { id: C(20), name: "Card payment", kind: "transfer", parentId: null, color: null },
];

/** [day, name, merchant, category, business, cents]. November: income 6,480.00, spending 4,230.00. */
const NOVEMBER: [number, string, string | null, number | null, "personal" | "ugc", number][] = [
  [5, "Wordwise payout", "Wordwise", 1, "ugc", 160000],
  [19, "Wordwise payout", "Wordwise", 1, "ugc", 160000],
  [7, "Brightleaf payout", "Brightleaf", 2, "ugc", 104000],
  [21, "Brightleaf payout", "Brightleaf", 2, "ugc", 104000],
  [12, "Brand deal", "Zoe Studio", 3, "ugc", 70000],
  [20, "Brand deal", "zoe studio", 3, "ugc", 50000],
  [1, "Rent", "Maple Court", 10, "personal", -145000],
  [15, "IRS estimated tax", "IRS", 11, "ugc", -130000],
  [3, "Whole Foods", "Whole Foods", 17, "personal", -21000],
  [11, "Trader Joe's", "Trader Joe's", 17, "personal", -11000],
  [8, "Uber Eats", "Uber Eats", 12, "personal", -12000],
  [16, "Corner cafe", "Corner cafe", 12, "personal", -8000],
  [4, "Adobe Creative Cloud", "Adobe", 13, "ugc", -5999],
  [9, "Claude Pro", "Anthropic", 13, "ugc", -2000],
  [17, "Higgsfield", "Higgsfield", 13, "ugc", -23001],
  [6, "Target", "Target", 14, "personal", -8412],
  [13, "Amazon", "Amazon", 14, "personal", -20588],
  [18, "Amazon refund", "Amazon", 14, "personal", 4500],
  [2, "Gym", "Equinox", 15, "personal", -9000],
  [14, "Haircut", "Barber", 15, "personal", -11000],
  [10, "Uber", "Uber", 16, "personal", -6000],
  [18, "Gas", "Shell", 16, "personal", -12000],
  [19, "Mystery charge", null, null, "personal", -2500],
  [15, "Card payment", null, 20, "personal", -90000],
];
/** Each earlier month scales the November amounts, so the trend and the year to date have shape. */
const FACTORS = [0.82, 0.9, 1.05, 0.95, 1.1, 1.0, 0.88, 1.12, 0.97, 1.04];

function transactions(): FxTx[] {
  const out: FxTx[] = [];
  let n = 0;
  const add = (month: string, factor: number) => {
    for (const [d, name, merchant, cat, entity, cents] of NOVEMBER) {
      const fixed = cat === 10 || cat === 11 || cat === 20;
      out.push({
        id: g("f", ++n),
        day: `${month}-${String(d).padStart(2, "0")}`,
        name,
        merchant,
        cents: fixed ? cents : Math.round(cents * factor),
        entity,
        categoryId: cat === null ? null : C(cat),
        transfer: cat === 20,
      });
    }
  };
  FACTORS.forEach((f, i) => add(`2026-${String(i + 1).padStart(2, "0")}`, f));
  add(FIRST_MONTH, 1);
  out.push({ id: g("f", ++n), day: "2026-11-12", name: "Test charge", merchant: null, cents: -9900, entity: "personal", categoryId: C(15), hidden: true });
  return out;
}

export function fixtureDb(): FxDb {
  return {
    categories: CATEGORIES.map((c) => ({ ...c })),
    transactions: transactions(),
    taxLines: [
      { id: TL(8), code: "8", name: "Advertising", position: 8 },
      { id: TL(18), code: "18", name: "Office expense", position: 19 },
      { id: TL(23), code: "23", name: "Taxes and licenses", position: 25 },
      { id: TL(25), code: "25", name: "Utilities", position: 28 },
      { id: TL(27), code: "27b", name: "Other expenses", position: 31 },
    ],
    taxMap: { [`${C(13)}|${E.ugc}`]: TL(18), [`${C(11)}|${E.ugc}`]: TL(23) },
  };
}

// ---------------------------------------------------------------------------
// reports_flow and the six report functions
// ---------------------------------------------------------------------------

interface Flow {
  id: string;
  day: string;
  entityId: string;
  slug: "personal" | "ugc";
  kind: "income" | "expense";
  cents: number;
  topId: string | null;
  topName: string | null;
  payer: string;
  taxLineId: string | null;
}

function flow(db: FxDb): Flow[] {
  const cat = new Map(db.categories.map((c) => [c.id, c]));
  const out: Flow[] = [];
  for (const t of db.transactions) {
    if (t.hidden || t.transfer) continue;
    const c = t.categoryId ? cat.get(t.categoryId) : undefined;
    const kind = c?.kind ?? (t.cents >= 0 ? "income" : "expense");
    if (kind === "transfer") continue;
    const top = c ? (c.parentId ? cat.get(c.parentId) : c) : undefined;
    const entityId = E[t.entity];
    out.push({
      id: t.id,
      day: t.day,
      entityId,
      slug: t.entity,
      kind,
      cents: kind === "income" ? t.cents : -t.cents,
      topId: top?.id ?? null,
      topName: top?.name ?? null,
      payer: t.merchant?.trim() || t.name,
      taxLineId: (c && db.taxMap[`${c.id}|${entityId}`]) || (c?.parentId && db.taxMap[`${c.parentId}|${entityId}`]) || null,
    });
  }
  return out;
}

const sum = (rows: Flow[]) => rows.reduce((a, r) => a + r.cents, 0);
const ordered = (rows: Flow[]) => [...rows].sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id)).map((r) => r.id);
const groupBy = <T,>(rows: T[], key: (r: T) => string) => {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return [...m.values()];
};
const by = (...cmp: number[]) => cmp.find((c) => c !== 0) ?? 0;

type Args = { p_scope: string; p_from: string; p_to: string };

function inScope(db: FxDb, a: Args) {
  return flow(db).filter((r) => (a.p_scope === "all" || r.slug === a.p_scope) && r.day >= a.p_from && r.day <= a.p_to);
}

function cashFlowRows(db: FxDb, a: Args) {
  const f = inScope(db, a);
  const inc = groupBy(f.filter((r) => r.kind === "income"), (r) => r.topId ?? "none")
    .map((rows) => ({ id: `income:${rows[0]!.topId ?? "none"}`, label: rows[0]!.topName ?? "Uncategorized income", cents: sum(rows), ids: ordered(rows) }))
    .filter((r) => r.cents > 0);
  const exp = groupBy(
    f.filter((r) => r.kind === "expense"),
    (r) => (r.topName?.toLowerCase() === "taxes" ? "taxes" : (r.topId ?? "none")),
  )
    .map((rows) => {
      const taxes = rows[0]!.topName?.toLowerCase() === "taxes";
      return {
        id: taxes ? "taxes" : `expense:${rows[0]!.topId ?? "none"}`,
        label: taxes ? "Taxes set aside" : (rows[0]!.topName ?? "Uncategorized"),
        cents: sum(rows),
        ids: ordered(rows),
      };
    })
    .filter((r) => r.cents > 0);
  // Net totals over every row, as the SQL does (a refund-heavy group drops off the list but still counts).
  const i = sum(f.filter((r) => r.kind === "income"));
  const e = sum(f.filter((r) => r.kind === "expense"));
  const links = [
    ...inc.map((r) => ({ source_id: r.id, source_label: r.label, target_id: "income", target_label: "Income", cents: r.cents, row_ids: r.ids })),
    ...exp.map((r) => ({ source_id: "income", source_label: "Income", target_id: r.id, target_label: r.label, cents: r.cents, row_ids: r.ids })),
    ...(i > e ? [{ source_id: "income", source_label: "Income", target_id: "savings", target_label: "Savings", cents: i - e, row_ids: [] as string[] }] : []),
    ...(e > i ? [{ source_id: "drawn", source_label: "Drawn from savings", target_id: "income", target_label: "Income", cents: e - i, row_ids: [] as string[] }] : []),
  ];
  return links.sort((x, y) => by(y.cents - x.cents, x.source_id.localeCompare(y.source_id), x.target_id.localeCompare(y.target_id)));
}

function spendingRows(db: FxDb, a: Args) {
  const color = new Map(db.categories.map((c) => [c.id, c.color]));
  return groupBy(inScope(db, a).filter((r) => r.kind === "expense"), (r) => r.topId ?? "none")
    .map((rows) => ({ category_id: rows[0]!.topId, name: rows[0]!.topName ?? "Uncategorized", color: (rows[0]!.topId && color.get(rows[0]!.topId)) || null, cents: sum(rows), tx_count: rows.length, row_ids: ordered(rows) }))
    .filter((r) => r.cents > 0)
    .sort((x, y) => by(y.cents - x.cents, x.name.localeCompare(y.name)));
}

function payerRows(db: FxDb, a: Args) {
  return groupBy(inScope(db, a).filter((r) => r.kind === "income"), (r) => r.payer.trim().toLowerCase())
    .map((rows) => ({ payer: rows.map((r) => r.payer).sort()[0]!, cents: sum(rows), tx_count: rows.length, row_ids: ordered(rows) }))
    .filter((r) => r.cents > 0)
    .sort((x, y) => by(y.cents - x.cents, x.payer.localeCompare(y.payer)));
}

function trendRows(db: FxDb, a: Args) {
  const rows = inScope(db, a);
  const out = [];
  for (let m = a.p_from.slice(0, 7); m <= a.p_to.slice(0, 7); m = shiftMonth(m, 1)) {
    const f = rows.filter((r) => r.day.startsWith(m));
    const income = sum(f.filter((r) => r.kind === "income"));
    const spending = sum(f.filter((r) => r.kind === "expense"));
    out.push({ month: `${m}-01`, income_cents: income, spending_cents: spending, net_cents: income - spending, tx_count: f.length, row_ids: ordered(f) });
  }
  return out;
}

function taxRows(db: FxDb, a: Args) {
  const line = new Map(db.taxLines.map((t) => [t.id, t]));
  return groupBy(inScope(db, a).filter((r) => r.kind === "expense" && r.taxLineId), (r) => `${r.slug}|${r.day.slice(0, 4)}|${r.taxLineId}`)
    .map((rows) => {
      const t = line.get(rows[0]!.taxLineId!)!;
      return { entity_id: rows[0]!.entityId, entity_slug: rows[0]!.slug, year: Number(rows[0]!.day.slice(0, 4)), tax_line_id: t.id, code: t.code, name: t.name, cents: sum(rows), tx_count: rows.length, row_ids: ordered(rows), position: t.position };
    })
    .filter((r) => r.cents !== 0)
    .sort((x, y) => by(x.entity_slug.localeCompare(y.entity_slug), x.year - y.year, x.position - y.position))
    .map(({ position, ...r }) => (void position, r));
}

/** A Supabase client whose `rpc` is the six report functions over `db()`. Nothing else works. */
export function fixtureClient(db: () => FxDb): SupabaseClient {
  const fns: Record<string, (d: FxDb, a: Args) => unknown> = {
    reports_cash_flow: cashFlowRows,
    reports_spending_by_category: spendingRows,
    reports_income_by_payer: payerRows,
    reports_monthly_trend: trendRows,
    reports_tax_lines: taxRows,
  };
  return {
    rpc: async (fn: string, args: Args) => {
      const run = fns[fn];
      return run ? { data: run(db(), args), error: null } : { data: null, error: { message: `fixture has no ${fn}` } };
    },
  } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// Panel, downloads and edits
// ---------------------------------------------------------------------------

const categoryName = (db: FxDb, id: string | null) => {
  const c = db.categories.find((x) => x.id === id);
  if (!c) return "Uncategorized";
  const p = db.categories.find((x) => x.id === c.parentId);
  return p ? `${p.name} / ${c.name}` : c.name;
};
const BUSINESS = { personal: "Personal", ugc: "UGC" } as const;

function exportRows(db: FxDb, ids: readonly string[]): ExportTransaction[] {
  const want = new Set(ids);
  return db.transactions
    .filter((t) => want.has(t.id))
    .map((t) => ({ id: t.id, day: t.day, name: t.name, payer: t.merchant?.trim() || t.name, category: categoryName(db, t.categoryId), business: BUSINESS[t.entity], cents: t.cents }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
}

export async function fixtureExport(db: FxDb, scope: ReportScope, month: string): Promise<ExportInput> {
  const client = fixtureClient(() => db);
  const [data, year] = await Promise.all([loadReport(client, scope, month), loadYear(client, scope, month)]);
  return { data, transactions: exportRows(db, data.flow.rowIds), year: { ...year, transactions: exportRows(db, year.flow.rowIds) } };
}

export async function fixturePanel(db: FxDb, scope: ReportScope, month: string, key: string): Promise<PanelResult<CategoryPanelData>> {
  const none = key === "none-expense" || key === "none-income";
  const cat = none ? undefined : db.categories.find((c) => c.id === key);
  if (!none && !cat) return { ok: false, error: { code: "not_found", message: "That category is gone" } };
  const kind: "income" | "expense" = none ? (key === "none-income" ? "income" : "expense") : cat!.kind === "income" ? "income" : "expense";
  const { now, trend } = await panelFigures(fixtureClient(() => db), scope, month, kind, none ? null : key);
  const rows = exportRows(db, now.rowIds.slice(-PANEL_ROWS)).sort((a, b) => b.day.localeCompare(a.day) || b.id.localeCompare(a.id));
  const expense = !!cat && kind === "expense";
  return {
    ok: true,
    data: {
      key,
      name: cat?.name ?? (kind === "income" ? "Uncategorized income" : "Uncategorized"),
      kind,
      editable: !!cat,
      color: cat?.color ?? null,
      cents: now.cents,
      count: now.count,
      share: now.total > 0 ? now.cents / now.total : 0,
      rowIds: now.rowIds,
      transactions: rows.map((t) => ({ id: t.id, day: t.day, name: t.payer, cents: t.cents })),
      trend,
      entities: expense ? [{ id: E.ugc, name: "UGC" }] : [],
      taxLines: expense ? db.taxLines.map((t) => ({ id: t.id, label: `${t.code}  ${t.name}` })) : [],
      taxMap: Object.fromEntries(Object.entries(db.taxMap).filter(([k]) => k.startsWith(`${key}|`)).map(([k, v]) => [k.split("|")[1]!, v])),
      mergeTargets: db.categories.filter((c) => c.parentId === null && c.kind === cat?.kind && c.id !== key).map((c) => ({ id: c.id, name: c.name })),
    },
  };
}

const fail = (code: string, message: string): PanelResult<never> => ({ ok: false, error: { code, message } });
const done: PanelResult<unknown> = { ok: true, data: null };

/** The panel's edits on an in-memory database. `db` is read and replaced through `store`. */
export function fixtureActions(store: { db: FxDb; set: (db: FxDb) => void }, month: () => string, scope: () => ReportScope): ReportsActions {
  const edit = (fn: (db: FxDb) => PanelResult<unknown> & { db?: FxDb }): PanelResult<unknown> => {
    const r = fn(store.db);
    if (r.ok && r.db) store.set(r.db);
    return r.ok ? done : r;
  };
  return {
    loadCategory: ({ key }) => fixturePanel(store.db, scope(), month(), key),
    rename: async ({ id, name }) =>
      edit((db) => {
        const c = db.categories.find((x) => x.id === id);
        if (!c) return fail("not_found", "That category is gone");
        if (db.categories.some((x) => x.id !== id && x.parentId === c.parentId && x.name.toLowerCase() === name.trim().toLowerCase())) return fail("conflict", "Category: that already exists");
        return { ok: true, data: null, db: { ...db, categories: db.categories.map((x) => (x.id === id ? { ...x, name: name.trim() } : x)) } };
      }),
    setColor: async ({ id, color }) => edit((db) => ({ ok: true, data: null, db: { ...db, categories: db.categories.map((x) => (x.id === id ? { ...x, color } : x)) } })),
    mapTaxLine: async ({ categoryId, entityId, taxLineId }) =>
      edit((db) => {
        const taxMap = { ...db.taxMap };
        if (taxLineId) taxMap[`${categoryId}|${entityId}`] = taxLineId;
        else delete taxMap[`${categoryId}|${entityId}`];
        return { ok: true, data: null, db: { ...db, taxMap } };
      }),
    merge: async ({ fromId, intoId }) =>
      edit((db) => {
        const a = db.categories.find((x) => x.id === fromId);
        const b = db.categories.find((x) => x.id === intoId);
        if (!a || !b) return fail("not_found", "That category is gone");
        if (a.kind !== b.kind) return fail("invalid_input", "Only categories of the same kind can be merged");
        return {
          ok: true,
          data: null,
          db: {
            ...db,
            categories: db.categories.filter((x) => x.id !== fromId).map((x) => (x.parentId === fromId ? { ...x, parentId: intoId } : x)),
            transactions: db.transactions.map((t) => (t.categoryId === fromId ? { ...t, categoryId: intoId } : t)),
            taxMap: Object.fromEntries(Object.entries(db.taxMap).filter(([k]) => !k.startsWith(`${fromId}|`))),
          },
        };
      }),
    remove: async ({ id }) =>
      edit((db) => {
        if (db.transactions.some((t) => t.categoryId === id) || db.categories.some((c) => c.parentId === id)) return fail("in_use", "This category is in use. Merge it or archive it");
        return { ok: true, data: null, db: { ...db, categories: db.categories.filter((c) => c.id !== id) } };
      }),
  };
}
