import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  goalPace,
  goalFigure,
  monthlyCents,
  nextEstimatedTax,
  nextPayday,
  postingStreak,
  prevMonth,
  prevMonthSpan,
  windowText,
} from "@/components/dashboard/derive";
import type {
  CardRow,
  ComingUpRow,
  DashboardData,
  GoalRow,
  NetWorthPoint,
  PostingDay,
  RecentTx,
} from "@/components/dashboard/types";
import { NO_ENTITY_ID, showsUgc, type Scope } from "@/lib/entities/model";
import { listAccounts, listTransactions } from "@/lib/bank/queries";
import { categoryColor } from "@/lib/label-colors";
import { addDays, dayOf, formatDay } from "@/lib/planning/dates";
import { eventsBetween } from "@/lib/planning/events";
import { readGoal, sortGoals } from "@/lib/planning/goals";
import { METRICS, createMetricRegistry, goalWindow } from "@/lib/planning/metrics";
import { loadSnapshot } from "@/lib/planning/repository";
import { ownerCtx } from "@/lib/planning/server";
import {
  MAX_NET_WORTH_DAYS,
  incomeSummary,
  monthlyTrend,
  netWorthChartPoints,
  netWorthSeries,
  spendingByCategory,
  thisMonth,
} from "@/lib/reports/queries";
import { trendRange } from "@/components/reports/model";
import { earnedPerDay, listDeals, missedViewDays, postingCalendarMonth } from "@/lib/ugc/queries";

/**
 * Everything the Dashboard shows, read as the signed-in owner. One call per scope; the cards and the
 * range switch work on this data in the browser. Money is integer cents, days are the owner's.
 * ponytail: each UGC read loads every UGC row (see lib/ugc/queries.ts); a goal on UGC revenue adds one more.
 */

const COMING_UP_DAYS = 30;
const GOALS_SHOWN = 6;
const RECENT_SHOWN = 8;
const COMING_UP_SHOWN = 8;


async function entityIds(db: SupabaseClient): Promise<Map<string, { id: string; name: string }>> {
  const { data, error } = await db.from("entities").select("id, slug, name");
  if (error) throw new Error(`entities: ${error.message}`);
  return new Map((data ?? []).map((e: { id: string; slug: string; name: string }) => [e.slug, { id: e.id, name: e.name }]));
}

interface RecurringRow {
  id: string;
  name: string;
  average_amount_cents: number;
  gap_days: number;
  next_expected_on: string;
}

/** Confirmed recurring items; with a scope, only those that charged an account of that entity lately. */
async function confirmedRecurring(db: SupabaseClient, entityId: string | undefined, today: string): Promise<RecurringRow[]> {
  const { data, error } = await db
    .from("recurring")
    .select("id, name, average_amount_cents, gap_days, next_expected_on")
    .eq("status", "confirmed");
  if (error) throw new Error(`recurring: ${error.message}`);
  const rows = (data ?? []).map((r) => ({ ...r, average_amount_cents: Number(r.average_amount_cents) })) as RecurringRow[];
  if (!entityId || rows.length === 0) return rows;
  const used = await db
    .from("transactions")
    .select("recurring_id")
    .eq("entity_id", entityId)
    .not("recurring_id", "is", null)
    .gte("posted_on", addDays(today, -120));
  if (used.error) throw new Error(`recurring use: ${used.error.message}`);
  const ids = new Set((used.data ?? []).map((t: { recurring_id: string }) => t.recurring_id));
  return rows.filter((r) => ids.has(r.id));
}

type CategoryRow = { id: string; name: string; color: string | null; parent_id: string | null };

/** Names and label colors; a subcategory with no color of its own takes its parent's. */
async function categoryNames(db: SupabaseClient, ids: string[]): Promise<Map<string, { name: string; color: string | null }>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await db.from("categories").select("id, name, color, parent_id").in("id", ids);
  if (error) throw new Error(`categories: ${error.message}`);
  const rows = (data ?? []) as CategoryRow[];
  const parentIds = [...new Set(rows.map((c) => c.parent_id).filter((p): p is string => !!p && !rows.some((c) => c.id === p)))];
  if (parentIds.length) {
    const parents = await db.from("categories").select("id, name, color, parent_id").in("id", parentIds);
    if (parents.error) throw new Error(`categories: ${parents.error.message}`);
    rows.push(...((parents.data ?? []) as CategoryRow[]));
  }
  return new Map(rows.map((c) => [c.id, { name: c.name, color: categoryColor(rows, c.id) }]));
}

function postingDays(
  raw: {
    date: string;
    posted: number;
    target: number;
    earnedCents: number;
    missedCents: number;
    deals: { brandName: string; posted: number; target: number }[];
  }[],
  today: string,
): PostingDay[] {
  return raw.map((d) => ({
    lines: d.deals.length > 1 ? d.deals.map((c) => `${c.brandName} ${c.posted} of ${c.target}`) : undefined,
    day: Number(d.date.slice(8, 10)),
    date: d.date,
    label: formatDay(d.date, today),
    posted: d.posted,
    target: d.target,
    future: d.date > today,
    amountCents: d.missedCents > 0 ? -d.missedCents : d.earnedCents,
  }));
}

export async function loadDashboard(scope: Scope): Promise<DashboardData> {
  const ctx = await ownerCtx();
  const { db } = ctx;
  const now = ctx.now();
  const tz = await ctx.timeZone();
  const today = dayOf(now.toISOString(), tz);
  const entities = await entityIds(db);
  const entityId = scope === "all" ? undefined : (entities.get(scope)?.id ?? NO_ENTITY_ID);
  const withUgc = showsUgc(scope);
  const month = thisMonth(today);
  const prev = prevMonthSpan(today);

  const [accounts, series, income, incomePrev, spending, spendingPrev, trend, txs, recurring, snapshot, deals, calendar, viewGaps] = await Promise.all([
    listAccounts(db, { entityId }),
    netWorthSeries(db, scope, { from: addDays(today, 1 - MAX_NET_WORTH_DAYS), to: today }),
    incomeSummary(db, scope, month),
    incomeSummary(db, scope, prev),
    spendingByCategory(db, scope, month),
    spendingByCategory(db, scope, prev),
    // Twelve months for the income and expenses chart, scoped by the transaction's entity as Reports is. It ends
    // today, as the strip above it does, so a future-dated row counts in neither until its day.
    monthlyTrend(db, scope, { from: trendRange(month.from.slice(0, 7)).from, to: today }),
    listTransactions(db, { entityId, pageSize: RECENT_SHOWN + 8 }),
    confirmedRecurring(db, entityId, today),
    loadSnapshot(db),
    withUgc ? listDeals({ now }) : null,
    withUgc ? postingCalendarMonth({ month: today.slice(0, 7), now }) : null,
    // The warning is an extra: a failed read leaves it out rather than failing the board.
    withUgc ? missedViewDays({ now }).catch(() => []) : [],
  ]);

  // Accounts.
  const cash = accounts.filter((a) => a.kind === "cash");
  const cards: CardRow[] = accounts
    .filter((a) => a.kind === "card")
    .map((a) => ({
      id: a.id,
      name: a.nickname ?? a.name,
      owedCents: a.balance?.current_cents ?? 0,
      statementCents: a.statement_balance_effective_cents,
      dueOn: a.statement_due_effective_on,
      limitCents: a.balance?.limit_cents ?? null,
    }));
  const asOf = accounts.map((a) => a.balance?.as_of).filter((d): d is string => !!d).sort().at(-1);

  // Net worth: drop the days before the first account had a balance.
  const netWorth: NetWorthPoint[] = netWorthChartPoints(series.points, today);

  // UGC and posting.
  let ugc: DashboardData["ugc"] = null;
  let posting: DashboardData["posting"] = null;
  if (deals && calendar) {
    ugc = { ...deals.totals, deals: deals.deals.length, missedViewDays: viewGaps };
    const days = postingDays(calendar.days, today);
    let run = postingStreak(days, today);
    // The week strip and a streak that reaches the 1st both need last month.
    let joined = days;
    if (deals.deals.length > 0 && (run.reachedStart || Number(today.slice(8, 10)) < 7)) {
      const before = await postingCalendarMonth({ month: prevMonth(today.slice(0, 7)), now });
      joined = [...postingDays(before.days, today), ...days];
      if (run.reachedStart) run = postingStreak(joined, today);
    }
    posting = { days, week: joined.filter((d) => d.date <= today).slice(-7), streak: run.streak };
  }

  // Recurring per month.
  const recurringCents = recurring.filter((r) => r.average_amount_cents < 0).reduce((a, r) => a + monthlyCents(r.average_amount_cents, r.gap_days), 0);

  // Recent.
  const names = await categoryNames(db, [...new Set(txs.rows.map((t) => t.category_id).filter((c): c is string => !!c))]);
  const recent: RecentTx[] = txs.rows
    .filter((t) => !t.is_transfer)
    .slice(0, RECENT_SHOWN)
    .map((t) => {
      const c = t.category_id ? names.get(t.category_id) : undefined;
      return { id: t.id, name: t.name, category: c?.name ?? null, categoryColor: c?.color ?? null, cents: t.amount_cents };
    });

  // Goals, read live through a registry that answers from this same data.
  const streak = posting?.streak ?? null;
  const ugcEarned = new Map<string, number | null>();
  const registry = createMetricRegistry({
    net_worth: () => (netWorth.at(-1) ? netWorth.at(-1)!.netCents / 100 : null),
    monthly_income: () => income.incomeCents / 100,
    savings_rate: () => (income.incomeCents > 0 ? Math.round(((income.incomeCents - spending.totalCents) / income.incomeCents) * 1000) / 10 : null),
    streak: () => streak,
    category_spend: async (param, c) => {
      if (!param) return null;
      const r = await spendingByCategory(db, scope, { from: c.window.from, to: c.window.to < today ? c.window.to : today });
      const row = r.rows.find((x) => x.name.toLowerCase() === param.toLowerCase());
      return (row?.cents ?? 0) / 100;
    },
    ugc_revenue: async (_p, c) => {
      const key = `${c.window.from}:${c.window.to}`;
      if (!ugcEarned.has(key)) {
        try {
          const r = await earnedPerDay({ from: c.window.from, to: c.window.to < today ? c.window.to : today, now });
          ugcEarned.set(key, r.days.reduce((a, d) => a + d.cents, 0) / 100);
        } catch {
          ugcEarned.set(key, null);
        }
      }
      return ugcEarned.get(key) ?? null;
    },
    // Keys with no live source yet answer "nothing to measure", never a placeholder figure.
    posts_per_day: () => null,
    total_views: () => null,
    views_per_post: () => null,
  });
  const goals: GoalRow[] = await Promise.all(
    sortGoals(snapshot.goals)
      .filter((g) => !g.achievedAt)
      .slice(0, GOALS_SHOWN)
      .map(async (g): Promise<GoalRow> => {
        const reading = await readGoal(g, { tasks: snapshot.tasks, statuses: snapshot.statuses, today, timeZone: tz, registry });
        const win = goalWindow(g, today, tz);
        const lines: string[] = [];
        let text = `${reading.percent}%`;
        g.metrics.forEach((m, i) => {
          const def = METRICS[m.metric];
          const value = reading.metrics[i]?.value ?? null;
          const figures = `${goalFigure(def.unit, value)} / ${goalFigure(def.unit, m.target)}`;
          if (g.metrics.length === 1) text = figures;
          lines.push(`${def.label}: ${figures}${def.direction === "down" ? " (stay under)" : ""}`);
        });
        if (g.metrics.length === 0) {
          text = `${reading.tasks.done} / ${reading.tasks.total}`;
          lines.push("Task progress: linked tasks done");
        }
        lines.push(windowText(win.from, win.to, today));
        const first = g.metrics[0];
        const pace = first
          ? goalPace(
              { unit: METRICS[first.metric].unit, direction: METRICS[first.metric].direction, value: reading.metrics[0]?.value ?? null, target: first.target, deadline: g.deadline },
              today,
            )
          : null;
        if (pace) lines.push(pace);
        return { id: g.id, title: g.title, percent: reading.percent, text, info: lines.join("\n") };
      }),
  );

  // Coming up: card due dates, recurring bills, payouts, tax dates, events, tasks and reminders.
  const last = addDays(today, COMING_UP_DAYS);
  const inWindow = (d: string | null | undefined): d is string => !!d && d >= today && d <= last;
  const up: ComingUpRow[] = [];
  for (const c of cards) {
    if (c.owedCents > 0 && inWindow(c.dueOn)) {
      up.push({ key: `card-${c.id}`, date: c.dueOn, name: `${c.name} statement due`, cents: c.statementCents ?? c.owedCents, href: `/accounts?account=${c.id}` });
    }
  }
  for (const r of recurring) {
    if (inWindow(r.next_expected_on)) {
      const out = r.average_amount_cents < 0;
      up.push({ key: `rec-${r.id}`, date: r.next_expected_on, name: r.name, cents: Math.abs(r.average_amount_cents), signed: !out, href: "/accounts?tab=recurring" });
    }
  }
  for (const d of deals?.deals ?? []) {
    const day = d.deal.status === "active" && d.owedCents > 0 ? nextPayday(d.deal, today) : null;
    if (inWindow(day)) up.push({ key: `pay-${d.deal.id}`, date: day, name: `${d.deal.brand_name} payout`, cents: d.owedCents, signed: true, href: "/ugc" });
  }
  if (withUgc) {
    const tax = nextEstimatedTax(today);
    if (inWindow(tax.date)) up.push({ key: "tax", date: tax.date, name: tax.name, cents: null, href: "/taxes" });
  }
  for (const e of eventsBetween(snapshot.events, today, last, tz)) {
    up.push({ key: `event-${e.eventId}-${e.date}`, date: e.date, name: e.event.title, cents: null, href: "/planning" });
  }
  const doneStatus = new Set(snapshot.statuses.filter((s) => s.isDone).map((s) => s.id));
  for (const t of snapshot.tasks) {
    if (doneStatus.has(t.statusId)) continue;
    const day = t.alertAt ? dayOf(t.alertAt, tz) : t.dueDate;
    if (inWindow(day)) up.push({ key: `task-${t.id}`, date: day, name: t.title, cents: null, href: `/planning?task=${t.id}` });
  }
  up.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));

  const prevSpend = spendingPrev.totalCents;
  return {
    scope,
    // A slug with no business (a typo, a deleted one) reads as "this business", not the raw slug.
    scopeName: scope === "all" ? "All" : (entities.get(scope)?.name ?? "this business"),
    today,
    hasAccounts: accounts.length > 0,
    balancesAsOf: asOf ? formatDay(asOf, today) : null,
    netWorth,
    cash: { totalCents: cash.reduce((a, c) => a + (c.balance?.current_cents ?? 0), 0), rows: cash.map((c) => ({ id: c.id, name: c.nickname ?? c.name, cents: c.balance?.current_cents ?? 0 })) },
    cards: { totalCents: cards.reduce((a, c) => a + c.owedCents, 0), rows: cards },
    month: {
      incomeCents: income.incomeCents,
      incomeCount: income.incomeRowIds.length,
      netAfterCardsCents: income.netAfterCardsCents,
      cardBalanceCents: income.cardBalanceCents,
      spendingCents: spending.totalCents,
      spendingPrevCents: prevSpend > 0 ? prevSpend : null,
      prev: { incomeCents: incomePrev.incomeCents, spendingCents: prevSpend },
      recurringCents,
      recurringCount: recurring.filter((r) => r.average_amount_cents < 0).length,
    },
    trend: trend.months.map((m) => ({ month: m.month, incomeCents: m.incomeCents, spendingCents: m.spendingCents })),
    categories: spending.rows.filter((r) => r.cents > 0).map((r) => ({ name: r.name, cents: r.cents })),
    refundCents: Math.max(0, spending.refundCents),
    ugc,
    posting,
    recent,
    goals,
    comingUp: up.slice(0, COMING_UP_SHOWN),
  };
}
