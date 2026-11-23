// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  cashFlow,
  incomeByPayer,
  incomeByPayerYtd,
  incomeSummary,
  monthlyTrend,
  netWorthChartPoints,
  netWorthSeries,
  sankeyData,
  spendingByCategory,
  taxLineTotals,
  thisMonth,
  yearToDate,
} from "./queries";

/**
 * The shaping half of the proof. The database half (supabase/tests/0050_reports.test.sql) sums a
 * hand-checked fixture to the cent; the rows below are that test's expected output, so the numbers
 * here are the same hand-checked ones.
 */

const pad = (n: number) => String(n).padStart(12, "0");
const T = (n: number) => `e0000000-0000-4000-8000-${pad(n)}`;
const A = (n: number) => `a0000000-0000-4000-8000-${pad(n)}`;
const C = (n: number) => `c0000000-0000-4000-8000-${pad(n)}`;

/** Answers every function with `rows`; cash flow also reads the monthly trend for its net totals (`trend`). */
function rpcDb(rows: unknown, error: { message: string } | null = null, trend?: unknown[]) {
  const rpc = vi.fn(async (fn: string) => ({ data: error ? null : fn === "reports_monthly_trend" && trend ? trend : rows, error }));
  return { db: { rpc } as unknown as SupabaseClient, rpc };
}
const trendOf = (month: string, income: number, spending: number, ids: string[]) => [
  { month, income_cents: income, spending_cents: spending, net_cents: income - spending, tx_count: ids.length, row_ids: ids },
];
const JAN_TREND = trendOf("2026-01-01", 950500, 193699, [1, 2, 3, 4, 5, 6, 7, 8, 9, 14, 15, 16, 17, 18].map(T));

const JAN = { from: "2026-01-01", to: "2026-01-31" };

const flowRows = [
  ["income", "Income", "savings", "Savings", 756801, []],
  [`income:${C(1)}`, "Paycheck", "income", "Income", 600000, [T(1), T(2)]],
  [`income:${C(2)}`, "Brand deals", "income", "Income", 200000, [T(14)]],
  [`income:${C(3)}`, "Platform payouts", "income", "Income", 150000, [T(15)]],
  ["income", "Income", `expense:${C(4)}`, "Housing", 120000, [T(3)]],
  ["income", "Income", "taxes", "Taxes set aside", 50000, [T(7)]],
  ["income", "Income", `expense:${C(5)}`, "Advertising", 10000, [T(17)]],
  ["income", "Income", `expense:${C(6)}`, "Software and apps", 6500, [T(16), T(18)]],
  ["income", "Income", `expense:${C(7)}`, "Food", 6200, [T(4), T(5), T(6)]],
  ["income", "Income", "expense:none", "Uncategorized", 999, [T(8)]],
  ["income:none", "Uncategorized income", "income", "Income", 500, [T(9)]],
].map(([source_id, source_label, target_id, target_label, cents, row_ids]) => ({
  source_id,
  source_label,
  target_id,
  target_label,
  cents,
  row_ids,
}));

describe("inputs", () => {
  it("sends the scope and the inclusive range to the database function", async () => {
    const { db, rpc } = rpcDb([]);
    await cashFlow(db, "ugc", JAN);
    expect(rpc).toHaveBeenCalledWith("reports_cash_flow", { p_scope: "ugc", p_from: "2026-01-01", p_to: "2026-01-31" });
  });

  it("refuses a bad scope, a malformed or impossible date, and a backwards range, before any call", async () => {
    const { db, rpc } = rpcDb([]);
    // Any entity slug is a scope (closed UGM and added businesses too); a malformed one is refused.
    await expect(cashFlow(db, "UGM LLC", JAN)).rejects.toThrow('unknown scope "UGM LLC"');
    await expect(cashFlow(db, "all", { from: "2026-1-1", to: "2026-01-31" })).rejects.toThrow("bad date range");
    await expect(cashFlow(db, "all", { from: "2026-02-30", to: "2026-03-01" })).rejects.toThrow("not a real date");
    await expect(cashFlow(db, "all", { from: "2026-02-01", to: "2026-01-31" })).rejects.toThrow("starts after it ends");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("caps net worth at 1000 days (the API row limit) and allows exactly 1000", async () => {
    const { db } = rpcDb([]);
    await expect(netWorthSeries(db, "all", { from: "2023-01-01", to: "2026-01-01" })).rejects.toThrow("at most 1000 days");
    await expect(netWorthSeries(db, "all", { from: "2026-01-01", to: "2028-09-26" })).resolves.toBeDefined(); // 1000 days
    await expect(netWorthSeries(db, "all", { from: "2026-01-01", to: "2028-09-27" })).rejects.toThrow("at most 1000 days");
  });

  it("throws a plain error when the database fails or answers in the wrong shape", async () => {
    await expect(cashFlow(rpcDb(null, { message: "permission denied" }).db, "all", JAN)).rejects.toThrow(
      "reports_cash_flow: permission denied",
    );
    await expect(cashFlow(rpcDb([{ source_id: 1 }]).db, "all", JAN)).rejects.toThrow("unexpected rows");
  });

  it("builds year to date and this month from a day", () => {
    expect(yearToDate("2026-11-21")).toEqual({ from: "2026-01-01", to: "2026-11-21" });
    expect(thisMonth("2026-11-21")).toEqual({ from: "2026-11-01", to: "2026-11-21" });
  });
});

describe("cash flow", () => {
  it("shapes the January fixture: 9,505.00 earned, 1,936.99 spent, 7,568.01 saved, balanced", async () => {
    const flow = await cashFlow(rpcDb(flowRows, null, JAN_TREND).db, "all", JAN);
    expect(flow.incomeCents).toBe(950500);
    expect(flow.spendingCents).toBe(193699);
    expect(flow.savingsCents).toBe(756801);
    expect(flow.drawnCents).toBe(0);
    expect(flow.incomeCents - flow.spendingCents).toBe(flow.savingsCents);
    expect(flow.nodes.find((n) => n.id === "income")).toMatchObject({ column: 1, cents: 950500 });
    expect(flow.nodes.find((n) => n.id === `income:${C(1)}`)).toMatchObject({ label: "Paycheck", column: 0, cents: 600000 });
    expect(flow.nodes.find((n) => n.id === "taxes")).toMatchObject({ label: "Taxes set aside", column: 2, cents: 50000 });
    expect(flow.nodes).toHaveLength(12);
  });

  it("cites every transaction that counts in the range once", async () => {
    const flow = await cashFlow(rpcDb(flowRows, null, JAN_TREND).db, "all", JAN);
    expect(flow.rowIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 14, 15, 16, 17, 18].map(T));
    expect(flow.links.find((l) => l.target === `expense:${C(7)}`)?.rowIds).toEqual([T(4), T(5), T(6)]);
  });

  it("covers spending above income with Drawn from savings, and reports no savings", async () => {
    const rows = [
      { source_id: "drawn", source_label: "Drawn from savings", target_id: "income", target_label: "Income", cents: 1500, row_ids: [] },
      { source_id: "income", source_label: "Income", target_id: `expense:${C(5)}`, target_label: "Advertising", cents: 1500, row_ids: [T(19)] },
    ];
    const flow = await cashFlow(rpcDb(rows, null, trendOf("2025-12-01", 0, 1500, [T(19)])).db, "ugc", { from: "2025-12-01", to: "2025-12-31" });
    expect(flow).toMatchObject({ incomeCents: 0, drawnCents: 1500, spendingCents: 1500, savingsCents: 0 });
    expect(flow.nodes.find((n) => n.id === "drawn")).toMatchObject({ column: 0, cents: 1500 });
  });

  it("a refund larger than its category's spend: totals are net over every row, to the cent", async () => {
    // April: Dining -30.00 and +40.00 refund (dropped from the list), Rent -12.00, Paycheck +1000.00.
    const rows = [
      { source_id: `income:${C(1)}`, source_label: "Paycheck", target_id: "income", target_label: "Income", cents: 100000, row_ids: [T(4)] },
      { source_id: "income", source_label: "Income", target_id: "savings", target_label: "Savings", cents: 99800, row_ids: [] },
      { source_id: "income", source_label: "Income", target_id: `expense:${C(4)}`, target_label: "Housing", cents: 1200, row_ids: [T(3)] },
      { source_id: "refunds", source_label: "Refunds", target_id: "income", target_label: "Income", cents: 1000, row_ids: [T(1), T(2)] },
    ];
    const flow = await cashFlow(rpcDb(rows, null, trendOf("2026-04-01", 100000, 200, [T(1), T(2), T(3), T(4)])).db, "all", { from: "2026-04-01", to: "2026-04-30" });
    expect(flow).toMatchObject({ incomeCents: 100000, spendingCents: 200, savingsCents: 99800, drawnCents: 0 });
    // RM-02: the hub balances, so the destination shares add up to 100%.
    expect(flow.hubCents).toBe(101000);
    expect(flow.links.filter((l) => l.source === "income").reduce((a, l) => a + l.cents, 0)).toBe(flow.hubCents);
    expect(flow.nodes.find((n) => n.id === "refunds")).toMatchObject({ label: "Refunds", column: 0, cents: 1000 });
    expect(flow.incomeCents - flow.spendingCents).toBe(flow.savingsCents);
    expect(flow.rowIds).toEqual([T(1), T(2), T(3), T(4)]); // both Dining rows reach the CSV
  });

  it("returns empty, zeroed output for an empty period", async () => {
    const flow = await cashFlow(rpcDb([]).db, "all", JAN);
    expect(flow).toMatchObject({ nodes: [], links: [], incomeCents: 0, spendingCents: 0, savingsCents: 0, rowIds: [] });
  });

  it("hands the kit Sankey nodes by name and links by node index", async () => {
    const flow = await cashFlow(rpcDb(flowRows, null, JAN_TREND).db, "all", JAN);
    const s = sankeyData(flow);
    expect(s.nodes).toHaveLength(12);
    expect(s.links).toHaveLength(11);
    const named = s.links.map((l) => [s.nodes[l.source].name, s.nodes[l.target].name, l.value]);
    expect(named).toContainEqual(["Income", "Savings", 756801]);
    expect(named).toContainEqual(["Paycheck", "Income", 600000]);
    expect(named).toContainEqual(["Income", "Taxes set aside", 50000]);
  });
});

describe("spending by category", () => {
  const rows = [
    ["Housing", 120000, 1, [T(3)], C(4)],
    ["Taxes", 50000, 1, [T(7)], C(8)],
    ["Advertising", 10000, 1, [T(17)], C(5)],
    ["Software and apps", 6500, 2, [T(16), T(18)], C(6)],
    ["Food", 6200, 3, [T(4), T(5), T(6)], C(7)],
    ["Uncategorized", 999, 1, [T(8)], null],
  ].map(([name, cents, tx_count, row_ids, category_id]) => ({ category_id, name, color: null, cents, tx_count, row_ids }));

  it("totals 1,936.99 and gives each category its share", async () => {
    const r = await spendingByCategory(rpcDb(rows, null, JAN_TREND).db, "all", JAN);
    expect(r.totalCents).toBe(193699);
    expect(r.refundCents).toBe(0);
    expect(r.rows.map((x) => x.name)).toEqual(["Housing", "Taxes", "Advertising", "Software and apps", "Food", "Uncategorized"]);
    expect(r.rows[0].share).toBeCloseTo(120000 / 193699, 12);
    expect(r.rows.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1, 12);
    expect(r.rows[3]).toMatchObject({ count: 2, cents: 6500, categoryId: C(6) });
    expect(r.rows[5].categoryId).toBeNull();
    expect(r.rowIds).toHaveLength(9);
  });

  it("has no shares when there is no spending", async () => {
    expect(await spendingByCategory(rpcDb([], null, trendOf("2026-01-01", 0, 0, [])).db, "all", JAN)).toEqual({ rows: [], totalCents: 0, listedCents: 0, refundCents: 0, rowIds: [] });
  });

  it("totals net spending like the trend when a refund pushes a category below zero (RM-03)", async () => {
    // April 2027 (0050 pgTAP): Rent 12.00 listed, Food nets -10.00 and drops off the list; the trend says 2.00.
    const listed = [{ category_id: C(4), name: "Housing", color: null, cents: 1200, tx_count: 1, row_ids: [T(103)] }];
    const r = await spendingByCategory(rpcDb(listed, null, trendOf("2027-04-01", 100000, 200, [101, 102, 103, 104].map(T))).db, "all", { from: "2027-04-01", to: "2027-04-30" });
    expect(r).toMatchObject({ totalCents: 200, listedCents: 1200, refundCents: 1000 });
    expect(r.rows[0].share).toBe(1);
  });
});

describe("income by payer", () => {
  const rows = [
    { payer: "Acme Corp", cents: 600000, tx_count: 2, row_ids: [T(1), T(2)] },
    { payer: "BrandCo", cents: 250000, tx_count: 2, row_ids: [T(14), T(20)] },
    { payer: "TikTok", cents: 150000, tx_count: 1, row_ids: [T(15)] },
    { payer: "Venmo", cents: 500, tx_count: 1, row_ids: [T(9)] },
  ];

  it("totals per payer with shares and row ids", async () => {
    const r = await incomeByPayer(rpcDb(rows).db, "all", { from: "2026-01-01", to: "2026-02-28" });
    expect(r.totalCents).toBe(1000500);
    expect(r.rows[0]).toMatchObject({ payer: "Acme Corp", cents: 600000, count: 2 });
    expect(r.rows[0].share).toBeCloseTo(600000 / 1000500, 12);
    expect(r.rowIds).toEqual([1, 2, 14, 20, 15, 9].map(T));
  });

  it("year to date runs from January 1 to the given day", async () => {
    const { db, rpc } = rpcDb(rows);
    await incomeByPayerYtd(db, "ugc", "2026-02-28");
    expect(rpc).toHaveBeenCalledWith("reports_income_by_payer", { p_scope: "ugc", p_from: "2026-01-01", p_to: "2026-02-28" });
  });
});

describe("monthly trend", () => {
  it("shapes income, spending and net, and keeps the net to the cent", async () => {
    const rows = [
      { month: "2025-12-01", income_cents: 0, spending_cents: 1500, net_cents: -1500, tx_count: 1, row_ids: [T(19)] },
      { month: "2026-01-01", income_cents: 950500, spending_cents: 193699, net_cents: 756801, tx_count: 14, row_ids: [T(1), T(2)] },
      { month: "2026-02-01", income_cents: 50000, spending_cents: 8000, net_cents: 42000, tx_count: 3, row_ids: [T(20)] },
    ];
    const r = await monthlyTrend(rpcDb(rows).db, "all", { from: "2025-12-15", to: "2026-02-28" });
    expect(r.months.map((m) => [m.month, m.incomeCents, m.spendingCents, m.netCents])).toEqual([
      ["2025-12-01", 0, 1500, -1500],
      ["2026-01-01", 950500, 193699, 756801],
      ["2026-02-01", 50000, 8000, 42000],
    ]);
    for (const m of r.months) expect(m.incomeCents - m.spendingCents).toBe(m.netCents);
    expect(r.rowIds).toEqual([T(19), T(1), T(2), T(20)]);
  });
});

describe("tax line totals", () => {
  it("renames the columns and keeps the form line code as text", async () => {
    const rows = [
      { entity_id: C(90), entity_slug: "ugc", year: 2025, tax_line_id: C(91), code: "8", name: "Advertising", cents: 1500, tx_count: 1, row_ids: [T(19)] },
      { entity_id: C(90), entity_slug: "ugc", year: 2026, tax_line_id: C(92), code: "27b", name: "Other expenses", cents: 4000, tx_count: 1, row_ids: [T(18)] },
    ];
    const r = await taxLineTotals(rpcDb(rows).db, "ugc", { from: "2025-12-01", to: "2026-02-28" });
    expect(r.rows[1]).toEqual({
      entityId: C(90),
      entitySlug: "ugc",
      year: 2026,
      taxLineId: C(92),
      code: "27b",
      name: "Other expenses",
      cents: 4000,
      count: 1,
      rowIds: [T(18)],
    });
    expect(r.rowIds).toEqual([T(19), T(18)]);
  });
});

describe("income summary", () => {
  it("returns income before card bills and net after card bills", async () => {
    const rows = [
      {
        income_cents: 950500,
        card_balance_cents: 42777,
        net_after_cards_cents: 907723,
        income_row_ids: [T(1), T(2), T(9), T(14), T(15)],
        card_account_ids: [A(3), A(7)],
      },
    ];
    const r = await incomeSummary(rpcDb(rows).db, "all", JAN);
    expect(r).toMatchObject({ incomeCents: 950500, cardBalanceCents: 42777, netAfterCardsCents: 907723 });
    expect(r.incomeCents - r.cardBalanceCents).toBe(r.netAfterCardsCents);
    expect(r.rowIds).toEqual([T(1), T(2), T(9), T(14), T(15), A(3), A(7)]);
  });

  it("fails loudly when the database returns no row", async () => {
    await expect(incomeSummary(rpcDb([]).db, "all", JAN)).rejects.toThrow("no row");
  });
});

describe("net worth", () => {
  it("shapes the days and cites each account once", async () => {
    const rows = [
      { day: "2026-01-01", assets_cents: 600000, debts_cents: 27777, net_cents: 572223, account_ids: [A(1), A(2), A(3), A(7)], estimated: true },
      { day: "2026-01-05", assets_cents: 3100000, debts_cents: 27777, net_cents: 3072223, account_ids: [A(1), A(2), A(3), A(5), A(7)], estimated: false },
    ];
    const { db, rpc } = rpcDb(rows);
    const r = await netWorthSeries(db, "all", { from: "2026-01-01", to: "2026-01-05" });
    expect(rpc).toHaveBeenCalledWith("net_worth_history", { p_scope: "all", p_from: "2026-01-01", p_to: "2026-01-05" });
    expect(r.points[0]?.estimated).toBe(true);
    expect(r.points[1]).toEqual({ day: "2026-01-05", assetsCents: 3100000, debtsCents: 27777, netCents: 3072223, estimated: false });
    expect(r.rowIds).toEqual([A(1), A(2), A(3), A(7), A(5)]);
    for (const p of r.points) expect(p.assetsCents - p.debtsCents).toBe(p.netCents);
  });
});

describe("netWorthChartPoints (what loadDashboard hands the chart)", () => {
  const TODAY = "2026-11-21";
  const day = (i: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - (399 - i) * 86_400_000).toISOString().slice(0, 10);
  // 400 days: no value before day 10, estimated through day 394, real for the last 5.
  const rows = Array.from({ length: 400 }, (_, i) => {
    const a = i < 10 ? 0 : 1000 + i;
    return { day: day(i), assetsCents: a, debtsCents: 0, netCents: a, estimated: i < 395 };
  });

  it("starts at the first day with a value and thins the old days to one a week", () => {
    const out = netWorthChartPoints(rows, TODAY);
    expect(out[0].day).toBe(day(10));
    expect(out.at(-1)!.day).toBe(TODAY);
    expect(out.filter((p) => p.day >= "2026-07-24")).toHaveLength(121); // every day of the last 120
    expect(out.length).toBeLessThan(170);
  });

  it("keeps each day's estimated flag, so the hover can say so on real data", () => {
    const out = netWorthChartPoints(rows, TODAY);
    const byDay = new Map(rows.map((r) => [r.day, r.estimated]));
    for (const p of out) expect(p.estimated).toBe(byDay.get(p.day));
    expect(out.filter((p) => p.estimated).length).toBeGreaterThan(150);
    expect(out.slice(-5).map((p) => p.estimated)).toEqual([false, false, false, false, false]);
  });

  it("is empty when no account has a value yet", () => {
    expect(netWorthChartPoints([{ day: TODAY, assetsCents: 0, debtsCents: 0, netCents: 0, estimated: false }], TODAY)).toEqual([]);
  });
});
