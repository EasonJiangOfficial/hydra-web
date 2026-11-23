/**
 * Slice a day series (posts or views per day) into one Sunday-start month
 * grid (ported from Ripple lib/analytics/month-day-grid.ts). Pure. Day keys are
 * YYYY-MM-DD; "today" is UTC by default, the owner's zone when passed.
 *
 * `value: null` means the day has activity but no usable reading (never
 * paint that as a measured zero). `value: 0` means a real empty day.
 */
import { dayKeyInZone } from "@/lib/ugc/days";
import {
  currentUtcMonthKey,
  daysInUtcMonth,
  MONTH_KEY_REGEX,
  nextMonthKey,
  prevMonthKey,
} from "@/lib/ugc/posting-calendar";

export {
  currentUtcMonthKey,
  daysInUtcMonth,
  MONTH_KEY_REGEX,
  nextMonthKey,
  prevMonthKey,
};

/** One UTC day in a series the calendar can plot. */
export interface SeriesDay {
  /** YYYY-MM-DD (UTC). */
  date: string;
  /** Measured amount. null = unknown (missing reading). */
  value: number | null;
}

/** One cell in the Sunday-anchored month grid. */
export interface MonthGridCell {
  /** YYYY-MM-DD (UTC). Empty pad cells use "". */
  date: string;
  dayOfMonth: number;
  inMonth: boolean;
  value: number | null;
  isToday: boolean;
  /** Leading / trailing pad from the adjacent month. */
  isPad: boolean;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isUtcDayKey(value: string): boolean {
  return DAY_KEY.test(value);
}

/** YYYY-MM of a UTC day key. */
export function monthKeyOfDay(date: string): string {
  return date.slice(0, 7);
}

/** Distinct YYYY-MM keys covered by a series, oldest first. */
export function monthsCoveredBySeries(
  series: readonly Pick<SeriesDay, "date">[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of series) {
    if (!isUtcDayKey(row.date)) continue;
    const month = monthKeyOfDay(row.date);
    if (!MONTH_KEY_REGEX.test(month) || seen.has(month)) continue;
    seen.add(month);
    out.push(month);
  }
  out.sort();
  return out;
}

/**
 * Index a series by UTC day. Later rows for the same date overwrite (the
 * analytics series is already one row per day).
 */
export function indexSeriesByDay(
  series: readonly SeriesDay[],
): Map<string, number | null> {
  const byDay = new Map<string, number | null>();
  for (const row of series) {
    if (!isUtcDayKey(row.date)) continue;
    byDay.set(row.date, row.value);
  }
  return byDay;
}

/**
 * Views-by-day series from the analytics-bands payload.
 *
 * A day with posts but a 0 view total is UNKNOWN (never-measured views are
 * stored as 0). A day with no posts is a real 0. A day with a positive
 * total is a real reading. Frozen videos still carry their last positive
 * count, so they stay known.
 */
export function viewsSeriesFromBands(
  cadence: readonly { date: string; posts: number }[],
  views: readonly { date: string; total: number }[],
): SeriesDay[] {
  const viewsByDay = new Map<string, number>();
  for (const row of views) viewsByDay.set(row.date, row.total);
  return cadence.map((row) => {
    const total = viewsByDay.get(row.date) ?? 0;
    const posts = row.posts;
    if (posts > 0 && !(total > 0)) {
      return { date: row.date, value: null };
    }
    return { date: row.date, value: total };
  });
}

export function postsSeriesFromCadence(
  cadence: readonly { date: string; posts: number }[],
): SeriesDay[] {
  return cadence.map((row) => ({ date: row.date, value: row.posts }));
}

function leadPadSunday(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
}

/**
 * Sunday-start grid for `month`. Days missing from the series (outside
 * coverage, including future days) stay `value: null` (a dash), not a fake
 * measured 0. Days present in the series keep their reading, including a
 * real 0.
 */
export function buildMonthGrid(
  series: readonly SeriesDay[],
  month: string,
  now: Date = new Date(),
  zone: string = "UTC",
): MonthGridCell[] {
  if (!MONTH_KEY_REGEX.test(month)) return [];
  const byDay = indexSeriesByDay(series);
  const days = daysInUtcMonth(month);
  const pad = leadPadSunday(month);
  const today = dayKeyInZone(now, zone);
  const cells: MonthGridCell[] = [];

  for (let i = 0; i < pad; i++) {
    cells.push({
      date: "",
      dayOfMonth: 0,
      inMonth: false,
      value: null,
      isToday: false,
      isPad: true,
    });
  }

  for (let d = 1; d <= days; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    const value = byDay.has(date) ? byDay.get(date)! : null;
    cells.push({
      date,
      dayOfMonth: d,
      inMonth: true,
      value,
      isToday: date === today,
      isPad: false,
    });
  }

  return cells;
}

/** Latest month in `months` that is not after `current`, else current. */
export function defaultMonthKey(
  months: readonly string[],
  current: string = currentUtcMonthKey(),
): string {
  const inRange = months.filter((m) => m <= current);
  if (inRange.length === 0) return current;
  return inRange[inRange.length - 1]!;
}
