import type { CashFlow, PayerRow, ReportRange, ReportScope, SpendingRow, TaxLineTotal, TrendMonth } from "@/lib/reports/queries";

/**
 * What the Reports page shows (DESIGN.md section 6.4). Every figure comes from src/lib/reports queries,
 * with their `rowIds` kept so a number can cite the transactions behind it (and so the Hydra Agent can).
 * Plain data: it crosses from the server to the page, and the fixture builds the same shape in memory.
 */

export interface ReportsData {
  scope: ReportScope;
  /** The month on screen, YYYY-MM. */
  month: string;
  range: ReportRange;
  flow: CashFlow;
  /** totalCents is net spending (the headline's); refundCents is what categories a refund pushed below zero take off the listed rows. */
  spending: { rows: SpendingRow[]; totalCents: number; refundCents: number; rowIds: string[] };
  /** Income by payer, January 1 of the month's year through the month's last day. */
  payers: { range: ReportRange; rows: PayerRow[]; totalCents: number; rowIds: string[] };
  /** Twelve months ending with `month`. */
  trend: { range: ReportRange; months: TrendMonth[]; rowIds: string[] };
}

export type ReportTab = "cash-flow" | "spending" | "income" | "trends";
export const TABS: { value: ReportTab; label: string }[] = [
  { value: "cash-flow", label: "Cash flow" },
  { value: "spending", label: "Spending" },
  { value: "income", label: "Income" },
  { value: "trends", label: "Trends" },
];
export const parseTab = (v: string | null | undefined): ReportTab => TABS.find((t) => t.value === v)?.value ?? "cash-flow";

/** The bands that are earned income: into the Income hub, not "Drawn from savings" and not "Refunds" (spending netted back). */
export const incomeSources = (flow: Pick<CashFlow, "links">) =>
  flow.links.filter((l) => l.target === "income" && l.source !== "drawn" && l.source !== "refunds");

/** The figures in the top strip. Net income is income minus everything spent, taxes set aside included. */
export function headline(flow: Pick<ReportsData["flow"], "incomeCents" | "spendingCents">) {
  const netCents = flow.incomeCents - flow.spendingCents;
  return {
    incomeCents: flow.incomeCents,
    spendingCents: flow.spendingCents,
    netCents,
    /** Share of income kept; null when nothing came in. */
    savingsRate: flow.incomeCents > 0 ? netCents / flow.incomeCents : null,
  };
}

export const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

// ---------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const pad = (n: number) => String(n).padStart(2, "0");

export const isMonth = (v: string | null | undefined): v is string => !!v && MONTH.test(v);
/** `v` when it is a real month, else `fallback`. */
export const parseMonth = (v: string | null | undefined, fallback: string) => (isMonth(v) ? v : fallback);

export function shiftMonth(month: string, by: number) {
  const [y, m] = month.split("-").map(Number);
  const i = y * 12 + (m - 1) + by;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}

/** First through last day of the month. */
export function monthRange(month: string): ReportRange {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${pad(last)}` };
}

/** The twelve months ending with `month`. */
export const trendRange = (month: string): ReportRange => ({ from: `${shiftMonth(month, -11)}-01`, to: monthRange(month).to });
/** January 1 of the month's year through the month's last day. */
export const ytdRange = (month: string): ReportRange => ({ from: `${month.slice(0, 4)}-01-01`, to: monthRange(month).to });
/** The whole calendar year the month sits in (the tax pack). */
export const yearRange = (month: string): ReportRange => ({ from: `${month.slice(0, 4)}-01-01`, to: `${month.slice(0, 4)}-12-31` });

const NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (month: string) => NAMES[Number(month.slice(5, 7)) - 1]!;
export const monthLabel = (month: string) => `${monthName(month)} ${month.slice(0, 4)}`;
/** "Nov", and "Jan 26" for a January so a twelve-month axis shows where the year turns. */
export function monthShort(month: string, withYear = false) {
  const base = monthName(month).slice(0, 3);
  return withYear || month.endsWith("-01") ? `${base} ${month.slice(2, 4)}` : base;
}
/** "Nov 21" from YYYY-MM-DD. */
export const dayLabel = (day: string) => `${monthName(day.slice(0, 7)).slice(0, 3)} ${Number(day.slice(8, 10))}`;

// ---------------------------------------------------------------------------
// Sankey colors (DESIGN.md section 7: the one chart with color)
// ---------------------------------------------------------------------------

const BY_NAME: [RegExp, string][] = [
  [/hous|rent|mortgage/i, "var(--sankey-housing)"],
  [/food|grocer|dining|restaurant|coffee/i, "var(--sankey-food)"],
  [/software|app|subscript/i, "var(--sankey-software)"],
  [/shop|cloth|retail/i, "var(--sankey-shopping)"],
  [/transport|car|gas|fuel|travel|transit/i, "var(--sankey-transport)"],
];

/** Where the money went gets one muted color: the category's own, else by name, else the gray "other". */
export function destinationColor(nodeId: string, label: string, own: string | null | undefined): string {
  if (nodeId === "savings") return "var(--sankey-savings)";
  if (nodeId === "taxes") return "var(--sankey-taxes)";
  if (own) return own;
  return BY_NAME.find(([re]) => re.test(label))?.[1] ?? "var(--sankey-other)";
}

/**
 * The category a Sankey node opens. `expense:<id>` and `income:<id>` carry it; "Taxes set aside" is the
 * spending category named Taxes; Uncategorized opens the rows with no category. Savings, Income and
 * "Drawn from savings" hold no transactions, so they open nothing.
 */
export function nodeCategoryKey(nodeId: string, spending: Pick<ReportsData["spending"], "rows">): string | null {
  if (nodeId === "taxes") return spending.rows.find((r) => r.name.toLowerCase() === "taxes")?.categoryId ?? null;
  const [side, id] = nodeId.split(":");
  if (side !== "expense" && side !== "income") return null;
  return id === "none" ? `none-${side}` : (id ?? null);
}

// ---------------------------------------------------------------------------
// The category panel
// ---------------------------------------------------------------------------

export interface PanelTransaction {
  id: string;
  day: string;
  name: string;
  /** Signed as money moved: income in is positive, a charge is negative. */
  cents: number;
}

export interface CategoryPanelData {
  /** The category id, or `none-expense` / `none-income` for rows with no category. */
  key: string;
  name: string;
  kind: "income" | "expense";
  /** A real category you can rename, merge, color and map. */
  editable: boolean;
  color: string | null;
  /** What the period holds: spending is positive, so is income. */
  cents: number;
  count: number;
  /** Fraction of the period's spending (or income), 0 to 1. */
  share: number;
  rowIds: string[];
  /** Newest first, at most `PANEL_ROWS`. */
  transactions: PanelTransaction[];
  /** Six months ending with the one on screen. */
  trend: { label: string; value: number }[];
  /** Businesses a category can map to a Schedule C line for. */
  entities: { id: string; name: string }[];
  taxLines: { id: string; label: string }[];
  /** Entity id to tax line id. */
  taxMap: Record<string, string>;
  /** Same-kind, top-level categories this one can merge into. */
  mergeTargets: { id: string; name: string }[];
}

export const PANEL_ROWS = 100;

export type PanelResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

/** Everything the panel does. The page binds the server actions; the fixture binds memory. */
export interface ReportsActions {
  loadCategory(input: { key: string; scope: ReportScope; month: string }): Promise<PanelResult<CategoryPanelData>>;
  rename(input: { id: string; name: string }): Promise<PanelResult<unknown>>;
  setColor(input: { id: string; color: string | null }): Promise<PanelResult<unknown>>;
  mapTaxLine(input: { categoryId: string; entityId: string; taxLineId: string | null }): Promise<PanelResult<unknown>>;
  /** Asks first in the panel; this runs after the owner confirms. */
  merge(input: { fromId: string; intoId: string }): Promise<PanelResult<unknown>>;
  remove(input: { id: string }): Promise<PanelResult<unknown> & { activityId?: string | null }>;
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

export const EXPORT_KINDS = ["monthly-pdf", "transactions-csv", "payers-csv", "tax-pack"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export const isExportKind = (v: string | null): v is ExportKind => EXPORT_KINDS.includes(v as ExportKind);

export const DOWNLOADS: { kind: ExportKind; label: string }[] = [
  { kind: "monthly-pdf", label: "Monthly summary (PDF)" },
  { kind: "transactions-csv", label: "Transactions in this view (CSV)" },
  { kind: "payers-csv", label: "Income by payer (CSV)" },
  { kind: "tax-pack", label: "Year-end tax pack (PDF and CSV)" },
];

/** One transaction in an export: signed as money moved, so the column sums to net income. */
export interface ExportTransaction {
  id: string;
  day: string;
  name: string;
  payer: string;
  category: string;
  business: string;
  cents: number;
}

/** Everything an export file is built from. */
export interface ExportInput {
  data: ReportsData;
  /** The scope's display name ("All", or the entity's name); the PDF falls back to the slug without it. */
  scopeName?: string;
  transactions: ExportTransaction[];
  /** The whole calendar year, for the tax pack. */
  year: {
    range: ReportRange;
    flow: CashFlow;
    payers: ReportsData["payers"];
    taxLines: TaxLineTotal[];
    transactions: ExportTransaction[];
  };
}
