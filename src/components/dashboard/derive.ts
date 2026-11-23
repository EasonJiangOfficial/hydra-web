import { addDays, daysUntil, formatDay } from "@/lib/planning/dates";
import { formatMoney } from "@/components/kit/money";
import type { NetWorthPoint, PostingDay } from "./types";
import { perMonthCents } from "@/lib/recurring/period";

/** Pure helpers behind the Dashboard cards. No React, no database. */

export const RANGES = [
  { value: "1w", label: "1W" },
  { value: "1m", label: "1M" },
  { value: "3m", label: "3M" },
  { value: "ytd", label: "YTD" },
  { value: "all", label: "All" },
] as const;
export type Range = (typeof RANGES)[number]["value"];

const SINCE: Record<Range, string> = {
  "1w": "this week",
  "1m": "past month",
  "3m": "past 3 months",
  ytd: "this year",
  all: "all time",
};
export const sinceText = (r: Range) => SINCE[r];

/** The points inside the range (oldest first). Always at least the last point. */
export function sliceNetWorth(points: readonly NetWorthPoint[], range: Range, today: string): NetWorthPoint[] {
  const from =
    range === "1w"
      ? addDays(today, -7)
      : range === "1m"
        ? addDays(today, -30)
        : range === "3m"
          ? addDays(today, -91)
          : range === "ytd"
            ? `${today.slice(0, 4)}-01-01`
            : "";
  const out = points.filter((p) => p.day >= from);
  return out.length > 0 ? out : points.slice(-1);
}

/**
 * Change from the first to the last point, and as a share of the first. The share is null when
 * the range started at zero or below: a percent off a debt reads as nonsense (-$299 to $3,383 is not "+1231%").
 */
export function netWorthDelta(points: readonly NetWorthPoint[]): { cents: number; pct: number | null } {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return { cents: 0, pct: null };
  const cents = last.netCents - first.netCents;
  return { cents, pct: first.netCents <= 0 ? null : (cents / first.netCents) * 100 };
}

/** "4.6%" (one decimal, no sign). */
export const pctText = (pct: number) => `${Math.abs(pct).toFixed(1).replace(/\.0$/, "")}%`;
/** "+12%" or "-8%": whole numbers for the spending pill. */
export const signedPct = (pct: number) => `${pct > 0 ? "+" : pct < 0 ? "-" : ""}${Math.abs(Math.round(pct))}%`;

/** "Due in 6 days", "Due today", "Overdue". */
export function dueLabel(dueOn: string, today: string): { text: string; overdue: boolean } {
  const n = daysUntil(dueOn, today);
  if (n < 0) return { text: "Overdue", overdue: true };
  if (n === 0) return { text: "Due today", overdue: false };
  return { text: n === 1 ? "Due tomorrow" : `Due in ${n} days`, overdue: false };
}

/**
 * Days in a row the posting target was hit, counting back from today. Today does not break the run
 * while it is still short. A day with target 0 (a day off) is skipped. `days` is one month, oldest first.
 * `reachedStart` is true when the run got to the first day of `days`, so the caller can look further back.
 */
export function postingStreak(
  days: readonly Pick<PostingDay, "date" | "posted" | "target" | "future">[],
  today: string,
): { streak: number; reachedStart: boolean } {
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const d = days[i];
    if (d.future || d.date > today) continue;
    if (d.target === 0) continue;
    if (d.posted >= d.target) streak += 1;
    else if (d.date !== today) return { streak, reachedStart: false };
  }
  return { streak, reachedStart: true };
}

/** A recurring charge as a monthly amount, in the same "Every" buckets as Accounts (one source: lib/recurring/period). */
export function monthlyCents(avgCents: number, gapDays: number): number {
  return perMonthCents(Math.abs(avgCents), gapDays);
}

/** Next pay day on or after `today` for a deal's pay cycle; null for cycles with no fixed day. */
export function nextPayday(
  deal: {
    pay_cycle: string | null;
    pay_cycle_anchor_day: number | null;
    pay_cycle_anchor_weekday: number | null;
    pay_cycle_anchor_days: number[] | null;
  },
  today: string,
): string | null {
  const t = new Date(`${today}T00:00:00Z`);
  if (deal.pay_cycle === "WEEKLY" && deal.pay_cycle_anchor_weekday !== null) {
    return addDays(today, (deal.pay_cycle_anchor_weekday - t.getUTCDay() + 7) % 7);
  }
  const days =
    deal.pay_cycle === "MONTHLY" && deal.pay_cycle_anchor_day
      ? [deal.pay_cycle_anchor_day]
      : deal.pay_cycle === "DAYS_OF_MONTH"
        ? (deal.pay_cycle_anchor_days ?? [])
        : [];
  if (days.length === 0) return null;
  for (let m = 0; m < 3; m += 1) {
    const base = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + m, 1));
    const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
    const ym = base.toISOString().slice(0, 8);
    for (const d of [...days].sort((a, b) => a - b)) {
      const date = `${ym}${String(Math.min(d, last)).padStart(2, "0")}`;
      if (date >= today) return date;
    }
  }
  return null;
}

/** US estimated-tax due dates for a sole proprietor: Jan 15, Apr 15, Jun 15, Sep 15. The next one on or after `today`. */
export function nextEstimatedTax(today: string): { date: string; name: string } {
  const y = Number(today.slice(0, 4));
  const list = [
    { date: `${y}-01-15`, name: `Q4 ${y - 1} estimated tax` },
    { date: `${y}-04-15`, name: `Q1 ${y} estimated tax` },
    { date: `${y}-06-15`, name: `Q2 ${y} estimated tax` },
    { date: `${y}-09-15`, name: `Q3 ${y} estimated tax` },
    { date: `${y + 1}-01-15`, name: `Q4 ${y} estimated tax` },
  ];
  return list.find((e) => e.date >= today)!;
}

export type GoalNumbers = {
  unit: "money" | "percent" | "count" | "days";
  direction: "up" | "down";
  /** Money in dollars, as the metric registry holds it. */
  value: number | null;
  target: number;
  deadline: string | null;
};

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** "$3.9k", "31%", "65", "9d": short enough for a narrow column. */
export function goalFigure(unit: GoalNumbers["unit"], n: number | null): string {
  if (n === null) return "-";
  if (unit === "money") return formatMoney(Math.round(n * 100), { compact: true });
  if (unit === "percent") return `${Math.round(n * 10) / 10}%`;
  if (unit === "days") return `${Math.round(n)}d`;
  return n >= 10_000 ? compact.format(n) : String(Math.round(n * 10) / 10);
}

/** What it takes per day to land on target by the deadline; null when there is no way to say. */
export function goalPace(g: GoalNumbers, today: string): string | null {
  if (g.value === null || g.direction === "down" || !g.deadline || (g.unit !== "money" && g.unit !== "count")) return null;
  const left = g.target - g.value;
  if (left <= 0) return "Target reached";
  const per = left / Math.max(1, daysUntil(g.deadline, today));
  return g.unit === "money"
    ? `Needs ${formatMoney(Math.round(per * 100), { whole: true })} a day`
    : `Needs ${Math.round(per * 10) / 10} a day`;
}

/** "Nov 1 to Nov 30". */
export const windowText = (from: string, to: string, today: string) => `${formatDay(from, today)} to ${formatDay(to, today)}`;

/** "Saturday, November 21" from a YYYY-MM-DD key (no time zone involved). */
export function longDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Last month's first day through the same day of the month (clamped to a short month): the span "same days last month" compares. */
export function prevMonthSpan(today: string): { from: string; to: string } {
  const [y, m, d] = today.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 2, 1));
  const last = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  const ym = first.toISOString().slice(0, 8);
  return { from: `${ym}01`, to: `${ym}${String(Math.min(d, last)).padStart(2, "0")}` };
}

/** The month before `month` ("YYYY-MM"). */
export function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

/** `?scope=` as a Scope (lib/entities/model, shared with the client switch). */
export { parseScope as scopeFrom } from "@/lib/entities/model";
