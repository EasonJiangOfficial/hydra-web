import type { SupabaseClient } from "@supabase/supabase-js";
import { cashFlow, incomeByPayer, monthlyTrend, spendingByCategory, taxLineTotals, type ReportScope } from "@/lib/reports/queries";
import { monthRange, monthShort, shiftMonth, trendRange, yearRange, ytdRange, type ReportsData } from "./model";

/**
 * The numbers, all from src/lib/reports. Shared by the page (a real client) and the /dev/reports fixture
 * (a client whose `rpc` answers from memory), so the shaping is the same code in both. No server-only
 * imports here.
 */

export async function loadReport(db: SupabaseClient, scope: ReportScope, month: string): Promise<ReportsData> {
  const range = monthRange(month);
  const ytd = ytdRange(month);
  const trend = trendRange(month);
  const [flow, spending, payers, months] = await Promise.all([
    cashFlow(db, scope, range),
    spendingByCategory(db, scope, range),
    incomeByPayer(db, scope, ytd),
    monthlyTrend(db, scope, trend),
  ]);
  return { scope, month, range, flow, spending, payers: { range: ytd, ...payers }, trend: { range: trend, ...months } };
}

/** The whole calendar year the month sits in: what the tax pack adds to the month. */
export async function loadYear(db: SupabaseClient, scope: ReportScope, month: string) {
  const range = yearRange(month);
  const [flow, payers, taxLines] = await Promise.all([cashFlow(db, scope, range), incomeByPayer(db, scope, range), taxLineTotals(db, scope, range)]);
  return { range, flow, payers: { range, ...payers }, taxLines: taxLines.rows };
}

/**
 * One category's figures for `month` and the five months before it. Expense categories read
 * spending by category; income categories read the cash flow link from their income source.
 * `id` is the top-level category id, or null for rows with no category.
 */
export async function panelFigures(db: SupabaseClient, scope: ReportScope, month: string, kind: "income" | "expense", id: string | null) {
  const figures = async (m: string) => {
    const range = monthRange(m);
    if (kind === "expense") {
      const s = await spendingByCategory(db, scope, range);
      const row = s.rows.find((r) => r.categoryId === id);
      // The share base is the listed categories, as on the Spending tab's table.
      return { cents: row?.cents ?? 0, count: row?.count ?? 0, rowIds: row?.rowIds ?? [], total: s.listedCents };
    }
    const f = await cashFlow(db, scope, range);
    const link = f.links.find((l) => l.source === `income:${id ?? "none"}` && l.target === "income");
    return { cents: link?.cents ?? 0, count: link?.rowIds.length ?? 0, rowIds: link?.rowIds ?? [], total: f.incomeCents };
  };
  const earlier = [5, 4, 3, 2, 1].map((n) => shiftMonth(month, -n));
  const [now, ...before] = await Promise.all([figures(month), ...earlier.map(figures)]);
  return {
    now,
    trend: [...earlier, month].map((m, i) => ({ label: monthShort(m), value: (i < earlier.length ? before[i]! : now).cents })),
  };
}
