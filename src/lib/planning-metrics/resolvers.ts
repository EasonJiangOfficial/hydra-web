import { addDays } from "@/lib/planning/dates";
import type { MetricContext, MetricKey, MetricResolver } from "@/lib/planning/metrics";

import type { DayRange, MetricSource, PostingDay } from "./source";

/**
 * The real metric resolvers (DESIGN.md section 10), against the MetricResolver interface in
 * src/lib/planning/metrics.ts. Each answers in the metric's own unit (dollars, percent, count,
 * days) or null when there is nothing to measure yet. task_progress is not here: it needs only
 * tasks, and the registry already ships it.
 */

/** The streak reads the posting calendar a month at a time, newest first, and stops at the first missed day. */
const STREAK_CHUNK_DAYS = 31;
/** About a year back at most. */
export const STREAK_MAX_CHUNKS = 12;

const dollars = (cents: number): number => cents / 100;
const round = (n: number, places: number): number => Math.round(n * 10 ** places) / 10 ** places;
const monthOf = (today: string): DayRange => ({ from: `${today.slice(0, 7)}-01`, to: today });

/** The goal's dates up to today: a future day has nothing to count. Null when it has not started. */
export function untilToday(window: DayRange, today: string): DayRange | null {
  const to = window.to > today ? today : window.to;
  return window.from > to ? null : { from: window.from, to };
}

export type MetricResolvers = Partial<Record<Exclude<MetricKey, "task_progress">, MetricResolver>>;

export function createResolvers(source: MetricSource): MetricResolvers {
  const spans = (ctx: MetricContext) => untilToday(ctx.window, ctx.today);
  return {
    net_worth: async (_param, ctx) => {
      const cents = await source.netWorthCents(ctx.today);
      return cents === null ? null : dollars(cents);
    },

    monthly_income: async (_param, ctx) => dollars(await source.incomeCents(monthOf(ctx.today))),

    ugc_revenue: async (_param, ctx) => {
      const range = spans(ctx);
      return range ? dollars(await source.ugcEarnedCents(range)) : null;
    },

    savings_rate: async (_param, ctx) => {
      const range = monthOf(ctx.today);
      const [income, spent] = await Promise.all([source.incomeCents(range), source.spending(range)]);
      return income > 0 ? round(((income - spent.totalCents) / income) * 100, 1) : null;
    },

    category_spend: async (param, ctx) => {
      const range = spans(ctx);
      const wanted = param?.trim().toLowerCase();
      if (!range || !wanted) return null;
      const { rows } = await source.spending(range);
      const row = rows.find((r) => r.categoryId === param || r.name.toLowerCase() === wanted);
      return dollars(row?.cents ?? 0);
    },

    posts_per_day: async (_param, ctx) => {
      const range = spans(ctx);
      if (!range) return null;
      const days = await source.postingDays(range);
      if (days.length === 0) return null;
      return round(days.reduce((n, d) => n + d.posted, 0) / days.length, 2);
    },

    streak: async (_param, ctx) => {
      let days: readonly PostingDay[] = [];
      let to = ctx.today;
      for (let chunk = 0; chunk < STREAK_MAX_CHUNKS; chunk += 1) {
        const from = addDays(to, -(STREAK_CHUNK_DAYS - 1));
        days = [...(await source.postingDays({ from, to })), ...days];
        if (streakRun(days, ctx.today).ended) break;
        to = addDays(from, -1);
      }
      if (days.every((d) => d.target === 0 && d.posted === 0)) return null;
      return streakRun(days, ctx.today).count;
    },

    total_views: async (_param, ctx) => {
      const range = spans(ctx);
      return range ? (await source.views(range, ctx.timeZone)).views : null;
    },

    views_per_post: async (_param, ctx) => {
      const range = spans(ctx);
      if (!range) return null;
      const { posts, views } = await source.views(range, ctx.timeZone);
      return posts > 0 ? Math.round(views / posts) : null;
    },
  };
}

/**
 * Days in a row, newest back, where the posting target was hit. Today does not break the run while
 * it is still open: it counts when hit, and is skipped when not yet. A day off (target 0) neither
 * counts nor breaks. `ended` is false when the days given ran out before a missed day.
 */
export function streakRun(
  days: readonly { date: string; posted: number; target: number }[],
  today: string,
): { count: number; ended: boolean } {
  const byDate = new Map(days.map((d) => [d.date, d]));
  let count = 0;
  for (let date = today; ; date = addDays(date, -1)) {
    const d = byDate.get(date);
    if (!d) return { count, ended: false };
    if (d.target === 0) continue;
    if (d.posted >= d.target) count += 1;
    else if (date !== today) return { count, ended: true };
  }
}

export const streakEndingToday = (days: readonly { date: string; posted: number; target: number }[], today: string): number =>
  streakRun(days, today).count;
