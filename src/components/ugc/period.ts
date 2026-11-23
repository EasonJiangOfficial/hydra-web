/**
 * The UGC Tracker's period: Daily, Weekly (Monday start), Monthly or Custom, as two inclusive day keys in the
 * owner's time zone. It lives in the URL (`?period=weekly&from=2026-11-16&to=2026-11-22`); no period means this
 * month. Day keys are pure calendar math, so steps never drift across DST; the instants come from the zone.
 */
import { DAY_KEY_REGEX, addDays, daysInMonth, zonedDayStart } from "@/lib/ugc/days";

export const PERIODS = ["daily", "weekly", "monthly", "custom"] as const;
export type Period = (typeof PERIODS)[number];
export const PERIOD_LABEL: Record<Period, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", custom: "Custom" };

export interface PeriodRange {
  period: Period;
  /** First day, "YYYY-MM-DD", inclusive. */
  from: string;
  /** Last day, inclusive. */
  to: string;
}

const isPeriod = (v: string | null | undefined): v is Period => PERIODS.some((p) => p === v);
/** The days a period may cover. Outside them a URL day is unreadable (and `Date.UTC` maps years 0-99 to 19xx). */
export const MIN_DAY = "2000-01-01";
export const MAX_DAY = "2099-12-31";
/** The longest custom range, as the analytics grid (MAX_GRID_DAYS): a year, leap day included. */
export const MAX_CUSTOM_DAYS = 366;
const isDay = (v: string | null | undefined): v is string => !!v && DAY_KEY_REGEX.test(v) && v >= MIN_DAY && v <= MAX_DAY;

/** A custom range from two days in either order, cut to MAX_CUSTOM_DAYS from its first day. */
export function customRange(a: string, b: string): PeriodRange {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const last = addDays(from, MAX_CUSTOM_DAYS - 1);
  return { period: "custom", from, to: to > last ? last : to };
}

/** 0 = Monday ... 6 = Sunday, of a day key. */
function mondayIndex(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** The daily, weekly or monthly period that holds `day`. */
export function periodAt(period: Exclude<Period, "custom">, day: string): PeriodRange {
  if (period === "daily") return { period, from: day, to: day };
  if (period === "weekly") {
    const from = addDays(day, -mondayIndex(day));
    return { period, from, to: addDays(from, 6) };
  }
  const month = day.slice(0, 7);
  return { period, from: `${month}-01`, to: `${month}-${String(daysInMonth(month)).padStart(2, "0")}` };
}

/**
 * The period the URL asks for. A fixed period is anchored on `from` (any day inside it works); a custom range
 * sorts its two days, takes one when the other is missing and is cut to MAX_CUSTOM_DAYS. Days outside
 * MIN_DAY..MAX_DAY are unreadable; anything unreadable falls back to this month.
 */
export function parsePeriod(q: { period?: string | null; from?: string | null; to?: string | null }, today: string): PeriodRange {
  const period = isPeriod(q.period) ? q.period : "monthly";
  const from = isDay(q.from) ? q.from : null;
  const to = isDay(q.to) ? q.to : null;
  if (period !== "custom") return periodAt(period, from ?? today);
  const a = from ?? to ?? today;
  return customRange(a, to ?? a);
}

/** The period `delta` steps away (custom ranges step by their own length). */
export function stepPeriod(r: PeriodRange, delta: number): PeriodRange {
  if (r.period === "daily") return periodAt("daily", addDays(r.from, delta));
  if (r.period === "weekly") return periodAt("weekly", addDays(r.from, 7 * delta));
  if (r.period === "monthly") {
    const [y, m] = r.from.split("-").map(Number);
    return periodAt("monthly", new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 10));
  }
  const len = dayCount(r);
  return { period: "custom", from: addDays(r.from, delta * len), to: addDays(r.to, delta * len) };
}

/** Days in the range, both ends counted. */
export function dayCount(r: Pick<PeriodRange, "from" | "to">): number {
  return Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** The range as instants in `zone`: local midnight of `from` to 1 ms before the midnight after `to`. */
export function periodInstants(r: Pick<PeriodRange, "from" | "to">, zone: string): { start: Date; end: Date } {
  return { start: zonedDayStart(r.from, zone), end: new Date(zonedDayStart(addDays(r.to, 1), zone).getTime() - 1) };
}

/** The URL params for a period: `from` and `to` always, `period` left out for the default (monthly). */
export function periodParams(r: PeriodRange): Record<"period" | "from" | "to", string | null> {
  return { period: r.period === "monthly" ? null : r.period, from: r.from, to: r.to };
}

const fmt = (day: string, opts: Intl.DateTimeFormatOptions) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
};

/** "Sat, Nov 21", "Nov 16 – 22", "November 2026", "Oct 30 – Nov 21". The year shows only when it is not `today`'s. */
export function periodLabel(r: PeriodRange, today: string): string {
  const year = (day: string) => (day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" as const } : {});
  if (r.period === "monthly") return fmt(r.from, { month: "long", year: "numeric" });
  if (r.period === "daily") return fmt(r.from, { weekday: "short", month: "short", day: "numeric", ...year(r.from) });
  if (r.from === r.to) return fmt(r.from, { month: "short", day: "numeric", ...year(r.from) });
  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
  const left = fmt(r.from, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  const right =
    r.from.slice(0, 7) === r.to.slice(0, 7)
      ? fmt(r.to, { day: "numeric", ...year(r.to) })
      : fmt(r.to, { month: "short", day: "numeric", ...(sameYear ? year(r.to) : { year: "numeric" }) });
  return `${left} – ${right}`;
}
