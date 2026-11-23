/**
 * Month-grid posting calendar helpers (ported from Ripple lib/brand/posting-calendar.ts):
 * month-key validation and navigation, zero-seeded per-day buckets with footer
 * stats, display labels, and the 6-step intensity bucket.
 *
 * Pure leaf module. Ripple used UTC; `buildMonthCalendar` keeps UTC as the
 * default and takes the owner's zone in Hydra.
 */
import {
  buildCadence,
  type CadenceDay,
  type CadencePost,
} from "@/lib/ugc/creator-cadence";
import { MONTH_KEY_REGEX, zonedMonthRange } from "@/lib/ugc/days";

export { MONTH_KEY_REGEX };

/** Footer stats for one displayed month. */
export interface MonthCalendarStats {
  /** Distinct UTC days in the month with at least one post. */
  activeDays: number;
  /** Total posts in the month. */
  totalPosts: number;
  /** Busiest single day's post count (0 when the month had no posts). */
  peakDay: number;
}

/**
 * The GET /api/brand/posting-calendar response: one month of zero-seeded day
 * buckets, the first month with any tracked activity (for nav clamping), and
 * the footer stats.
 */
export interface MonthCalendarData {
  /** The "YYYY-MM" month this payload describes. */
  month: string;
  /** Zero-seeded day grid covering EVERY day of the month (never sparse). */
  days: CadenceDay[];
  /**
   * "YYYY-MM" of the org's earliest tracked post, or null when no post exists
   * yet. The client clamps ‹ prev navigation to this month.
   */
  firstActivityMonth: string | null;
  stats: MonthCalendarStats;
}

// ───────────────────────────── month-key helpers ────────────────────────────

/** True when `value` is a well-formed "YYYY-MM" calendar month key. */
export function isValidMonthKey(
  value: string | null | undefined,
): value is string {
  return !!value && MONTH_KEY_REGEX.test(value);
}

/** "YYYY-MM" (UTC) of the month containing `now` (injectable for tests). */
export function currentUtcMonthKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** The "YYYY-MM" key one month BEFORE `month` (handles the year boundary). */
export function prevMonthKey(month: string): string {
  const [y, m] = month.split("-").map(Number);
  // Day 1 of the month, minus one month — Date.UTC normalizes month 0 → Dec.
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

/** The "YYYY-MM" key one month AFTER `month` (handles the year boundary). */
export function nextMonthKey(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

/**
 * Clamp a target month into the browsable window: never before the org's
 * `firstActivityMonth` (when known) and never after `currentMonth`. "YYYY-MM"
 * keys compare correctly as strings, so plain `<`/`>` is exact.
 */
export function clampMonthKey(
  month: string,
  firstActivityMonth: string | null,
  currentMonth: string,
): string {
  if (month > currentMonth) return currentMonth;
  if (firstActivityMonth && month < firstActivityMonth) {
    // A first-activity month in the future (bad data) must still respect the
    // upper bound — never return a month beyond `currentMonth`.
    return firstActivityMonth > currentMonth ? currentMonth : firstActivityMonth;
  }
  return month;
}

// ───────────────────────────── month range / size ───────────────────────────

/**
 * Inclusive UTC range covering every instant of `month`:
 * `[YYYY-MM-01T00:00:00.000Z, last-day T23:59:59.999Z]` — so a post at 23:30Z
 * on the month's last day is inside it (matches `resolveDateRange("month")`).
 */
export function monthRangeUtc(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  // Day 0 of the NEXT month = the last day of this month.
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  return { start, end };
}

/** Number of calendar days in a "YYYY-MM" UTC month (handles leap years). */
export function daysInUtcMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ───────────────────────────── month aggregation ────────────────────────────

/**
 * Bucket posts into a zero-seeded day grid covering EVERY day of `month`, plus
 * the footer stats. Delegates the day walk + counting to the shared
 * {@link buildCadence} (the existing, exhaustively-tested cadence core) so
 * this calendar can never bucket a post differently from the rest of the
 * cadence stack. Posts outside the month are ignored (defensive — the route
 * already scopes the query to the month window).
 */
export function buildMonthCalendar(
  posts: readonly CadencePost[],
  month: string,
  zone: string = "UTC",
): { days: CadenceDay[]; stats: MonthCalendarStats } {
  const { start, end } = zonedMonthRange(month, zone);
  const cadence = buildCadence(posts, start, end, zone);
  return {
    days: cadence.days,
    stats: {
      activeDays: cadence.summary.activeDays,
      totalPosts: cadence.summary.totalPosts,
      peakDay: cadence.summary.busiestDay?.count ?? 0,
    },
  };
}

// ───────────────────────────── display formatting ───────────────────────────

/** "YYYY-MM" → the month-nav heading, e.g. "Jun 2026" (UTC, no TZ drift). */
export function formatMonthHeading(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "YYYY-MM-DD" → the in-cell day label, e.g. "Jun 1" (UTC, no TZ drift). */
export function formatMonthDayLabel(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  if (!y || !m || !d) return dayKey;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * "YYYY-MM-DD" → the tooltip date, e.g. "Mon, Jun 1, 2026" — the same shape
 * the existing `PostingCadenceCalendar` heatmap tooltip uses, so the two
 * calendar surfaces speak one language.
 */
export function formatMonthDayFull(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  if (!y || !m || !d) return dayKey;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ───────────────────────────── intensity buckets ────────────────────────────

/** Number of intensity steps in the grid + its "Less … More" legend. */
export const MONTH_INTENSITY_STEPS = 6;

/**
 * Map a day's post count to one of 6 intensity buckets (0..5). Bucket 0 = no
 * posts (surface gray); 1..5 scale to the month's busiest day so a low-volume
 * month still gets a readable gradient (same ratio approach as the existing
 * heatmap's `intensityBucket`, one extra step for the richer legend).
 */
export function monthIntensityBucket(count: number, max: number): number {
  if (count <= 0) return 0;
  if (max <= 1) return MONTH_INTENSITY_STEPS - 1;
  const ratio = count / max;
  if (ratio <= 0.2) return 1;
  if (ratio <= 0.4) return 2;
  if (ratio <= 0.6) return 3;
  if (ratio <= 0.8) return 4;
  return 5;
}
