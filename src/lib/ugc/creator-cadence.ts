/**
 * Posting cadence: per-day post buckets, week (Monday start) and month
 * rollups, and date-range presets (ported from Ripple lib/brand/creator-cadence.ts).
 *
 * Pure leaf module. Ripple bucketed in UTC; `buildCadence` keeps UTC as the
 * default (so the ported tests hold) and takes the owner's zone in Hydra:
 * a post's day is its wall-clock date in that zone.
 */
import { addDays, dayKeyInZone } from "@/lib/ugc/days";

/** A single deduped post used for cadence — one per UnifiedVideo (best platform). */
export interface CadencePost {
  /** When the post went live on the platform. */
  postedAt: Date;
}

/** One day cell in the heatmap. */
export interface CadenceDay {
  /** "YYYY-MM-DD" (UTC). */
  date: string;
  /** Number of posts on this UTC day. */
  count: number;
}

/** A posts-per-week rollup row. */
export interface WeekRollup {
  /** ISO date ("YYYY-MM-DD", UTC) of the Monday that starts this week. */
  weekStart: string;
  /** Posts in this Mon–Sun week. */
  count: number;
}

/** A posts-per-month rollup row. */
export interface MonthRollup {
  /** "YYYY-MM" (UTC). */
  month: string;
  /** Posts in this calendar month. */
  count: number;
}

export interface CadenceSummary {
  /** Total posts in the window. */
  totalPosts: number;
  /** Distinct days that had at least one post. */
  activeDays: number;
  /** Busiest single day, or null when there were no posts. */
  busiestDay: CadenceDay | null;
  /** Mean posts per ISO week across the rendered weeks (0 when no weeks). */
  avgPerWeek: number;
  /** Mean posts per calendar month across the rendered months. */
  avgPerMonth: number;
}

export interface CadenceData {
  /** Inclusive UTC day range the calendar spans. */
  rangeStart: string;
  rangeEnd: string;
  /** Continuous day grid (zero-filled) for the heatmap. */
  days: CadenceDay[];
  /** Mon-anchored week rollups across the range. */
  weeks: WeekRollup[];
  /** Calendar-month rollups across the range. */
  months: MonthRollup[];
  summary: CadenceSummary;
}

// ───────────────────────────── UTC date helpers ─────────────────────────────

/** "YYYY-MM-DD" (UTC) for a Date. */
export function toUtcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** "YYYY-MM" (UTC) for a Date. */
export function toUtcMonthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** Parse "YYYY-MM-DD" to the UTC midnight Date for that day. */
export function utcDayStart(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

/**
 * Monday-anchored UTC week start for a given day key, as "YYYY-MM-DD".
 * JS `getUTCDay()` is 0=Sun..6=Sat; we shift so Monday is the anchor.
 */
export function utcWeekStartKey(key: string): string {
  const d = utcDayStart(key);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const deltaToMonday = (dow + 6) % 7; // Mon→0, Sun→6
  d.setUTCDate(d.getUTCDate() - deltaToMonday);
  return toUtcDayKey(d);
}

// ───────────────────────────── core aggregation ─────────────────────────────

/**
 * Bucket posts into a continuous, zero-filled day grid over [rangeStart,
 * rangeEnd] (inclusive, UTC), plus Mon-anchored week and calendar-month
 * rollups and a summary. Posts outside the range are ignored (defensive — the
 * caller already scopes the query).
 */
export function buildCadence(
  posts: readonly CadencePost[],
  rangeStart: Date,
  rangeEnd: Date,
  zone: string = "UTC",
): CadenceData {
  const startKey = dayKeyInZone(rangeStart, zone);
  const endKey = dayKeyInZone(rangeEnd, zone);

  // Count posts per day, ignoring anything outside the inclusive range.
  const byDay = new Map<string, number>();
  for (const post of posts) {
    const key = dayKeyInZone(post.postedAt, zone);
    if (key < startKey || key > endKey) continue;
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }

  // Continuous day grid (zero-filled), walking calendar days.
  const days: CadenceDay[] = [];
  for (let key = startKey; key <= endKey; key = addDays(key, 1)) {
    days.push({ date: key, count: byDay.get(key) ?? 0 });
  }

  // Week + month rollups derived from the day grid (so they share the range).
  const weekMap = new Map<string, number>();
  const monthMap = new Map<string, number>();
  for (const day of days) {
    const wk = utcWeekStartKey(day.date);
    weekMap.set(wk, (weekMap.get(wk) ?? 0) + day.count);
    const mk = day.date.slice(0, 7);
    monthMap.set(mk, (monthMap.get(mk) ?? 0) + day.count);
  }

  const weeks: WeekRollup[] = Array.from(weekMap.entries())
    .map(([weekStart, count]) => ({ weekStart, count }))
    .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
  const months: MonthRollup[] = Array.from(monthMap.entries())
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));

  const totalPosts = days.reduce((s, d) => s + d.count, 0);
  const activeDays = days.reduce((s, d) => s + (d.count > 0 ? 1 : 0), 0);
  const busiestDay = days.reduce<CadenceDay | null>((best, d) => {
    if (d.count === 0) return best;
    if (!best || d.count > best.count) return d;
    return best;
  }, null);

  const avgPerWeek = weeks.length
    ? Math.round((totalPosts / weeks.length) * 10) / 10
    : 0;
  const avgPerMonth = months.length
    ? Math.round((totalPosts / months.length) * 10) / 10
    : 0;

  return {
    rangeStart: startKey,
    rangeEnd: endKey,
    days,
    weeks,
    months,
    summary: { totalPosts, activeDays, busiestDay, avgPerWeek, avgPerMonth },
  };
}

// ───────────────────────── date-filter presets / ranges ─────────────────────

export type DateRangePreset = "today" | "day" | "week" | "month";

export interface DateRange {
  /** Inclusive UTC start (00:00:00.000Z). */
  start: Date;
  /** Inclusive UTC end (23:59:59.999Z). */
  end: Date;
}

/** UTC start-of-day for a Date (00:00:00.000Z). */
function startOfUtcDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** UTC end-of-day for a Date (23:59:59.999Z). */
function endOfUtcDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

/**
 * Resolve a preset (relative to `now`, or to an explicit `day` for the "day"
 * preset) into an inclusive UTC [start, end] range:
 *   - today : the UTC day containing `now`
 *   - day   : the UTC day of `dayKey` ("YYYY-MM-DD"); falls back to today
 *   - week  : Mon–Sun (UTC) ISO week containing `now`
 *   - month : the calendar month (UTC) containing `now`
 *
 * All boundaries are UTC, matching `buildCadence` and the route's day cursor,
 * so a post at 23:30Z on the last day of a range is still inside it.
 */
export function resolveDateRange(
  preset: DateRangePreset,
  now: Date,
  dayKey?: string | null,
): DateRange {
  if (preset === "day") {
    const base = dayKey ? utcDayStart(dayKey) : now;
    return { start: startOfUtcDay(base), end: endOfUtcDay(base) };
  }
  if (preset === "week") {
    const wkStart = utcDayStart(utcWeekStartKey(toUtcDayKey(now)));
    const wkEnd = new Date(wkStart);
    wkEnd.setUTCDate(wkEnd.getUTCDate() + 6);
    return { start: startOfUtcDay(wkStart), end: endOfUtcDay(wkEnd) };
  }
  if (preset === "month") {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const monthStart = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
    // Day 0 of next month = last day of this month.
    const monthEnd = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
    return { start: monthStart, end: monthEnd };
  }
  // "today"
  return { start: startOfUtcDay(now), end: endOfUtcDay(now) };
}

/** True when `postedAt` falls within the inclusive [start, end] range. */
export function isWithinRange(postedAt: Date, range: DateRange): boolean {
  const t = postedAt.getTime();
  return t >= range.start.getTime() && t <= range.end.getTime();
}

/** Validate a "YYYY-MM-DD" day key (calendar-valid, UTC). */
export function isValidDayKey(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = utcDayStart(value);
  return !Number.isNaN(d.getTime()) && toUtcDayKey(d) === value;
}

/** Narrow an arbitrary string to a DateRangePreset, defaulting to "month". */
export function parsePreset(value: string | null | undefined): DateRangePreset {
  if (value === "today" || value === "day" || value === "week" || value === "month") {
    return value;
  }
  return "month";
}
