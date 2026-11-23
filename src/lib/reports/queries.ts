import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { SLUG_RE, type Scope } from "@/lib/entities/model";
import { addDays } from "@/lib/planning/dates";

/**
 * Report reads (DESIGN.md section 9, PLAN.md U5). Each wraps one database function from
 * supabase/migrations/0050_reports.sql (net worth: 0115_net_worth_history.sql), checks its inputs and shapes the rows for the Reports page,
 * the Dashboard, Taxes and the Hydra Agent. Pass the signed-in client (RLS keeps it to the owner) or,
 * for the agent, a client on its read role. Money is integer cents. Dates are YYYY-MM-DD.
 *
 * Every result carries `rowIds`: the transaction ids (net worth: account ids) it used, so a caller
 * can cite them. A database error throws an Error with a plain message.
 */

/** 'all' or an entity slug (lib/entities/model). */
export type ReportScope = Scope;
/** Inclusive on both ends. */
export interface ReportRange {
  from: string;
  to: string;
}

/** PostgREST returns at most 1000 rows per call, and net worth is one row per day. */
export const MAX_NET_WORTH_DAYS = 1000;

const scopeSchema = z.string().refine((s) => s === "all" || SLUG_RE.test(s));
const dayRegex = /^\d{4}-\d{2}-\d{2}$/;
const isRealDay = (s: string) => {
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(s);
};
const day = z.string().regex(dayRegex, "not YYYY-MM-DD").refine(isRealDay, "not a real date");
const rangeSchema = z
  .object({ from: day, to: day })
  .refine((r) => r.from <= r.to, "range starts after it ends");

const cents = z.number().int();
const ids = z.array(z.guid());

function args(scope: ReportScope, range: ReportRange) {
  const s = scopeSchema.safeParse(scope);
  if (!s.success) throw new Error(`reports: unknown scope "${String(scope)}"`);
  const r = rangeSchema.safeParse(range);
  if (!r.success) throw new Error(`reports: bad date range (${r.error.issues[0]?.message})`);
  return { p_scope: s.data, p_from: r.data.from, p_to: r.data.to };
}

async function call<T extends z.ZodType>(db: SupabaseClient, fn: string, params: ReturnType<typeof args>, row: T) {
  const { data, error } = await db.rpc(fn, params);
  if (error) throw new Error(`${fn}: ${error.message}`);
  const parsed = z.array(row).safeParse(data ?? []);
  if (!parsed.success) throw new Error(`${fn}: unexpected rows (${parsed.error.issues[0]?.message})`);
  return parsed.data;
}

/** Unique ids in first-seen order. */
const union = (lists: readonly (readonly string[])[]) => [...new Set(lists.flat())];

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** January 1 of `asOf`'s year through `asOf` (income by payer, year to date). */
export const yearToDate = (asOf: string): ReportRange => ({ from: `${asOf.slice(0, 4)}-01-01`, to: asOf });
/** The 1st of `asOf`'s month through `asOf` ("income this month"). */
export const thisMonth = (asOf: string): ReportRange => ({ from: `${asOf.slice(0, 7)}-01`, to: asOf });

// ---------------------------------------------------------------------------
// Net worth
// ---------------------------------------------------------------------------

export interface NetWorthPoint {
  day: string;
  assetsCents: number;
  /** Cards and loans: what is owed, positive. */
  debtsCents: number;
  netCents: number;
  /** Some account's value that day was walked back from transactions, not a real balance. */
  estimated: boolean;
}

const netWorthRow = z.object({
  day,
  assets_cents: cents,
  debts_cents: cents,
  net_cents: cents,
  account_ids: ids,
  estimated: z.boolean(),
});

/**
 * Daily, from the first transaction or balance in scope (0115 net_worth_history): each account's
 * real balance, else walked back from its next real balance through its posted transactions; cash
 * and manual assets add, cards subtract.
 */
export async function netWorthSeries(db: SupabaseClient, scope: ReportScope, range: ReportRange) {
  const p = args(scope, range);
  const days = (Date.parse(`${p.p_to}T00:00:00Z`) - Date.parse(`${p.p_from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_NET_WORTH_DAYS) throw new Error(`reports: net worth covers at most ${MAX_NET_WORTH_DAYS} days`);
  const rows = await call(db, "net_worth_history", p, netWorthRow);
  const points: NetWorthPoint[] = rows.map((r) => ({
    day: r.day,
    assetsCents: r.assets_cents,
    debtsCents: r.debts_cents,
    netCents: r.net_cents,
    estimated: r.estimated,
  }));
  return { points, rowIds: union(rows.map((r) => r.account_ids)) };
}

/**
 * The Dashboard chart's points from netWorthSeries: from the first day any account had a value, every
 * day for the last 4 months and one a week before (1000 daily points are too many to ship). Each
 * point keeps its `estimated` flag: the hover says "Estimated from transactions" from it.
 */
export function netWorthChartPoints(points: readonly NetWorthPoint[], today: string): NetWorthPoint[] {
  const first = points.findIndex((p) => p.assetsCents !== 0 || p.debtsCents !== 0);
  if (first < 0) return [];
  const cut = addDays(today, -120);
  const kept = points.slice(first);
  return kept
    .filter((p, i) => p.day >= cut || i % 7 === 0 || i === kept.length - 1)
    .map((p) => ({ day: p.day, assetsCents: p.assetsCents, debtsCents: p.debtsCents, netCents: p.netCents, estimated: p.estimated }));
}

// ---------------------------------------------------------------------------
// Cash flow (Sankey)
// ---------------------------------------------------------------------------

export interface FlowNode {
  /** `income:<category id|none>`, `income`, `expense:<category id|none>`, `taxes`, `savings`, `drawn`, `refunds`, `reversals`. */
  id: string;
  label: string;
  /** 0 income sources (and drawn, refunds), 1 the Income hub, 2 where the money went (and reversals). */
  column: 0 | 1 | 2;
  cents: number;
}
export interface FlowLink {
  source: string;
  target: string;
  cents: number;
  rowIds: string[];
}

const flowRow = z.object({
  source_id: z.string(),
  source_label: z.string(),
  target_id: z.string(),
  target_label: z.string(),
  cents,
  row_ids: ids,
});

/**
 * Income sources -> Income -> each expense category, taxes set aside and savings. When spending is
 * above income, "Drawn from savings" feeds Income. Transfers and card payments are left out.
 * `taxes` is the expense category named Taxes.
 * The links list only groups whose net is above zero; groups a refund pushed below zero feed Income
 * as "Refunds" (or leave it as "Reversals" for income), so the hub balances. The totals (income,
 * spending, savings, the cited rows) are the net over every row in range: the headline, the PDF and
 * the CSVs agree with Trends to the cent.
 */
export async function cashFlow(db: SupabaseClient, scope: ReportScope, range: ReportRange) {
  const [rows, totals] = await Promise.all([call(db, "reports_cash_flow", args(scope, range), flowRow), monthlyTrend(db, scope, range)]);
  const nodes = new Map<string, FlowNode>();
  const node = (id: string, label: string, column: FlowNode["column"], add: number) => {
    const n = nodes.get(id) ?? { id, label, column, cents: 0 };
    n.cents += add;
    nodes.set(id, n);
  };
  const links: FlowLink[] = [];
  for (const r of rows) {
    const sourceColumn = r.source_id === "income" ? 1 : 0;
    node(r.source_id, r.source_label, sourceColumn, sourceColumn === 0 ? r.cents : 0);
    node(r.target_id, r.target_label, r.target_id === "income" ? 1 : 2, r.cents);
    links.push({ source: r.source_id, target: r.target_id, cents: r.cents, rowIds: r.row_ids });
  }
  const sum = (pick: (l: FlowLink) => boolean) => links.filter(pick).reduce((a, l) => a + l.cents, 0);
  const savingsCents = sum((l) => l.target === "savings");
  return {
    nodes: [...nodes.values()],
    links,
    /** Earned in the period, net of reversals (not counting "Drawn from savings"). */
    incomeCents: totals.months.reduce((a, m) => a + m.incomeCents, 0),
    drawnCents: sum((l) => l.source === "drawn"),
    /** Everything into the Income hub (= everything out of it): the base for each band's share. */
    hubCents: sum((l) => l.target === "income"),
    /** Everything spent, net of refunds, taxes set aside included, savings not. */
    spendingCents: totals.months.reduce((a, m) => a + m.spendingCents, 0),
    savingsCents,
    /** Every row that counts in the range, refunds in a dropped group included. */
    rowIds: totals.rowIds,
  };
}

export type CashFlow = Awaited<ReturnType<typeof cashFlow>>;

/** The kit Sankey's shape: nodes by index, links by node index. */
export function sankeyData(flow: Pick<CashFlow, "nodes" | "links">) {
  const index = new Map(flow.nodes.map((n, i) => [n.id, i]));
  return {
    nodes: flow.nodes.map((n) => ({ name: n.label })),
    links: flow.links.map((l) => ({ source: index.get(l.source)!, target: index.get(l.target)!, value: l.cents })),
  };
}

// ---------------------------------------------------------------------------
// Spending by category
// ---------------------------------------------------------------------------

export interface SpendingRow {
  /** The top-level category; null for rows with no category. */
  categoryId: string | null;
  name: string;
  color: string | null;
  cents: number;
  count: number;
  /** Fraction of the listed categories' sum, 0 to 1 (the donut). */
  share: number;
  rowIds: string[];
}

const spendingRow = z.object({
  category_id: z.guid().nullable(),
  name: z.string(),
  color: z.string().nullable(),
  cents,
  tx_count: z.number().int(),
  row_ids: ids,
});

/**
 * Spending per top-level expense category, largest first. Subcategories roll up; refunds net out.
 * `totalCents` is net spending over every row, the one definition the Reports headline, Trends, the
 * Dashboard and goals share (RM-03). `listedCents` sums the listed categories; it is above the total
 * by the categories a refund pushed below zero (`refundCents`).
 */
export async function spendingByCategory(db: SupabaseClient, scope: ReportScope, range: ReportRange) {
  const [rows, trend] = await Promise.all([call(db, "reports_spending_by_category", args(scope, range), spendingRow), monthlyTrend(db, scope, range)]);
  const listedCents = rows.reduce((a, r) => a + r.cents, 0);
  const totalCents = trend.months.reduce((a, m) => a + m.spendingCents, 0);
  const out: SpendingRow[] = rows.map((r) => ({
    categoryId: r.category_id,
    name: r.name,
    color: r.color,
    cents: r.cents,
    count: r.tx_count,
    share: listedCents > 0 ? r.cents / listedCents : 0,
    rowIds: r.row_ids,
  }));
  return { rows: out, totalCents, listedCents, refundCents: listedCents - totalCents, rowIds: union(out.map((r) => r.rowIds)) };
}

// ---------------------------------------------------------------------------
// Income by payer
// ---------------------------------------------------------------------------

export interface PayerRow {
  payer: string;
  cents: number;
  count: number;
  share: number;
  rowIds: string[];
}

const payerRow = z.object({ payer: z.string(), cents, tx_count: z.number().int(), row_ids: ids });

/** Income totalled per payer (merchant, else name; case and outer spaces ignored), largest first. */
export async function incomeByPayer(db: SupabaseClient, scope: ReportScope, range: ReportRange) {
  const rows = await call(db, "reports_income_by_payer", args(scope, range), payerRow);
  const totalCents = rows.reduce((a, r) => a + r.cents, 0);
  const out: PayerRow[] = rows.map((r) => ({
    payer: r.payer,
    cents: r.cents,
    count: r.tx_count,
    share: totalCents > 0 ? r.cents / totalCents : 0,
    rowIds: r.row_ids,
  }));
  return { rows: out, totalCents, rowIds: union(out.map((r) => r.rowIds)) };
}

/** Income by payer from January 1 of `asOf`'s year through `asOf`. */
export const incomeByPayerYtd = (db: SupabaseClient, scope: ReportScope, asOf: string) =>
  incomeByPayer(db, scope, yearToDate(asOf));

// ---------------------------------------------------------------------------
// Monthly trend
// ---------------------------------------------------------------------------

export interface TrendMonth {
  /** First day of the month, YYYY-MM-DD. */
  month: string;
  incomeCents: number;
  spendingCents: number;
  netCents: number;
  count: number;
  rowIds: string[];
}

const trendRow = z.object({
  month: day,
  income_cents: cents,
  spending_cents: cents,
  net_cents: cents,
  tx_count: z.number().int(),
  row_ids: ids,
});

/** Income, spending and net for each month the range touches; empty months are zeros. */
export async function monthlyTrend(db: SupabaseClient, scope: ReportScope, range: ReportRange) {
  const rows = await call(db, "reports_monthly_trend", args(scope, range), trendRow);
  const months: TrendMonth[] = rows.map((r) => ({
    month: r.month,
    incomeCents: r.income_cents,
    spendingCents: r.spending_cents,
    netCents: r.net_cents,
    count: r.tx_count,
    rowIds: r.row_ids,
  }));
  return { months, rowIds: union(months.map((m) => m.rowIds)) };
}

// ---------------------------------------------------------------------------
// Tax lines
// ---------------------------------------------------------------------------

export interface TaxLineTotal {
  entityId: string;
  entitySlug: string;
  year: number;
  taxLineId: string;
  /** Schedule C line, e.g. "8", "24b". */
  code: string;
  name: string;
  cents: number;
  count: number;
  rowIds: string[];
}

const taxRow = z.object({
  entity_id: z.guid(),
  entity_slug: z.string(),
  year: z.number().int(),
  tax_line_id: z.guid(),
  code: z.string(),
  name: z.string(),
  cents,
  tx_count: z.number().int(),
  row_ids: ids,
});

/** Expense totals per entity, calendar year and Schedule C line (rows with no line are left out). */
export async function taxLineTotals(db: SupabaseClient, scope: ReportScope, range: ReportRange) {
  const rows = await call(db, "reports_tax_lines", args(scope, range), taxRow);
  const out: TaxLineTotal[] = rows.map((r) => ({
    entityId: r.entity_id,
    entitySlug: r.entity_slug,
    year: r.year,
    taxLineId: r.tax_line_id,
    code: r.code,
    name: r.name,
    cents: r.cents,
    count: r.tx_count,
    rowIds: r.row_ids,
  }));
  return { rows: out, rowIds: union(out.map((r) => r.rowIds)) };
}

// ---------------------------------------------------------------------------
// Income summary
// ---------------------------------------------------------------------------

const summaryRow = z.object({
  income_cents: cents,
  card_balance_cents: cents,
  net_after_cards_cents: cents,
  income_row_ids: ids,
  card_account_ids: ids,
});

/**
 * Income before card bills (income in the range) and net after card bills (that minus what the open
 * cards owe on the last day of the range). `rowIds` holds the income transactions and the card accounts.
 */
export async function incomeSummary(db: SupabaseClient, scope: ReportScope, range: ReportRange) {
  const [r] = await call(db, "reports_income_summary", args(scope, range), summaryRow);
  if (!r) throw new Error("reports_income_summary: no row");
  return {
    incomeCents: r.income_cents,
    cardBalanceCents: r.card_balance_cents,
    netAfterCardsCents: r.net_after_cards_cents,
    incomeRowIds: r.income_row_ids,
    cardAccountIds: r.card_account_ids,
    rowIds: union([r.income_row_ids, r.card_account_ids]),
  };
}
