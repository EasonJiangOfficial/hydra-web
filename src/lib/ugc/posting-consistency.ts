/**
 * Posting consistency heatmap + streaks (ported from Ripple
 * lib/dashboard/posting-consistency.ts `buildConsistencyResponse`).
 *
 * Counting semantics (Ripple, user-requested):
 *   - Active day = a day with >= 1 post across any platform.
 *   - Per-day count = number of DISTINCT platforms that posted that day, so
 *     posting twice to Instagram on one day counts 1 for Instagram.
 *   - Streaks (current / longest) count distinct active days.
 *   - totalPosts = sum of per-day platform counts across the window.
 *
 * Days are "YYYY-MM-DD" in `zone` (default: this machine's zone, as Ripple used
 * server-local days). Hydra passes the owner's zone.
 */
import { addDays, dayKeyInZone, localZone } from "@/lib/ugc/days";

/** Default aggregation window (days) when the route's caller passes none. */
export const WINDOW_DAYS = 365;

export interface DayBucket {
  readonly date: string; // YYYY-MM-DD
  readonly count: number;
}

export interface ConsistencyResponse {
  readonly windowDays: number;
  readonly days: ReadonlyArray<DayBucket>;
  readonly totalPosts: number;
  readonly currentStreak: number;
  readonly longestStreak: number;
}

/**
 * Pure aggregation, exported for tests.
 *
 * Takes the raw PlatformPost rows (just the two fields we need) plus
 * the window boundaries and returns the heatmap payload. Keeping this
 * separate from the route handler lets us unit-test the counting and
 * streak logic without spinning up a database.
 */
export interface PlatformPostRow {
  readonly postedAt: Date;
  readonly platform: string;
}

export function buildConsistencyResponse(
  rows: ReadonlyArray<PlatformPostRow>,
  since: Date,
  now: Date,
  windowDays: number = WINDOW_DAYS,
  zone: string = localZone(),
): ConsistencyResponse {
  const localDateKey = (d: Date) => dayKeyInZone(d, zone);
  // Map<dateKey, Set<platform>> — Set dedupes multiple posts on the
  // same platform on the same day. Cardinality of the Set = the
  // per-day count we surface to the client.
  const dayPlatforms = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.postedAt.getTime() < since.getTime()) continue;
    const key = localDateKey(row.postedAt);
    const existing = dayPlatforms.get(key);
    if (existing) {
      existing.add(row.platform);
    } else {
      dayPlatforms.set(key, new Set<string>([row.platform]));
    }
  }

  // Build the full window so the client doesn't have to fill gaps.
  const days: DayBucket[] = [];
  const sinceKey = localDateKey(since);
  for (let i = 0; i < windowDays; i++) {
    const key = addDays(sinceKey, i);
    const set = dayPlatforms.get(key);
    days.push({ date: key, count: set ? set.size : 0 });
  }

  // totalPosts = Σ distinct (day, platform) tuples in the window.
  let totalPosts = 0;
  for (const set of dayPlatforms.values()) totalPosts += set.size;

  // Streaks operate on "was there any post this day" — boolean per
  // day, not weighted by platform count. Current streak counts back
  // from today; if today has nothing yet we anchor on yesterday so
  // the streak doesn't visually reset just because the day is young.
  const todayKey = localDateKey(now);
  const yesterdayKey = addDays(todayKey, -1);

  let currentStreak = 0;
  const startKey = dayPlatforms.has(todayKey) ? todayKey : yesterdayKey;
  const startIdx = days.findIndex((d) => d.date === startKey);
  if (startIdx !== -1) {
    for (let i = startIdx; i >= 0; i--) {
      if (days[i].count > 0) currentStreak++;
      else break;
    }
  }

  let longestStreak = 0;
  let run = 0;
  for (const d of days) {
    if (d.count > 0) {
      run++;
      if (run > longestStreak) longestStreak = run;
    } else {
      run = 0;
    }
  }

  return {
    windowDays,
    days,
    totalPosts,
    currentStreak,
    longestStreak,
  };
}
