/**
 * Projected income math (ported from Ripple lib/finances/projection.ts). Display
 * only: never feed these numbers into anything that moves money.
 *
 *   maxPosts(period) = daily target posts x days the deal existed in the period
 *   projected        = maxPosts x base pay per video
 *
 * A MONTH projection is a flat 30 days (owner, Ripple 2026-10-21, and DESIGN.md
 * section 3): daily target x 30 x base pay, whatever the month's length.
 * Bonuses and CPM are left out on purpose: projecting them needs a view
 * forecast, and Hydra never fakes a number.
 *
 * Money stays Decimal; callers convert to cents once (money.ts toCents).
 */
import Decimal from "decimal.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An inclusive period window. By convention `end` is the LAST instant of the
 * period (e.g. `endOfDay`/`endOfMonth`, i.e. 23:59:59.999), matching how the
 * finances page already builds its custom-range bounds.
 */
export interface PeriodWindow {
  start: Date;
  end: Date;
}

/**
 * Inclusive calendar-day count of a period window.
 *
 * Day count = round((end + 1ms − start) / 24h). The +1ms restores the
 * end-of-day convention to an exact day multiple, and rounding (not ceil)
 * absorbs DST shifts: a 31-day month containing a fall-back day spans
 * 31d + 1h and must still count 31, a spring-forward month spans 30d − 1h
 * and must still count 30.
 *
 * Returns 0 when the window is empty (end before start).
 */
export function countPeriodDays(start: Date, end: Date): number {
  const span = end.getTime() + 1 - start.getTime();
  if (span <= 0) return 0;
  return Math.max(0, Math.round(span / DAY_MS));
}

/**
 * Clamp a period to the campaign's existence: days before the campaign was
 * created can never produce posts and must not inflate the projection
 * ("partial period" proration). Returns null when the campaign did not exist
 * at any point of the window.
 */
export function clampPeriodToCampaign(
  period: PeriodWindow,
  campaignCreatedAt: Date,
  /** A deal archived inside the period stops counting at its archive instant. */
  campaignArchivedAt: Date | null = null,
): PeriodWindow | null {
  const end =
    campaignArchivedAt && campaignArchivedAt.getTime() < period.end.getTime()
      ? campaignArchivedAt
      : period.end;
  if (campaignCreatedAt.getTime() > end.getTime()) return null;
  const start =
    campaignCreatedAt.getTime() > period.start.getTime()
      ? campaignCreatedAt
      : period.start;
  if (start.getTime() > end.getTime()) return null;
  return { start, end };
}

/** dailyVideos < 1 (0 / negative / NaN from bad data) clamps to 0. */
export function postsPerDay(dailyVideos: number): number {
  return Number.isFinite(dailyVideos) && dailyVideos > 0
    ? Math.floor(dailyVideos)
    : 0;
}

/**
 * THE maxPosts formula (see module docstring for the source decision):
 *
 *   maxPosts = dailyVideos × inclusive days of (period ∩ campaign existence)
 *
 * dailyVideos < 1 (0 / negative / NaN from bad data) clamps to 0 — a
 * campaign with no posting cadence projects $0, never a negative number.
 */
export function maxPostsForPeriod(args: {
  dailyVideos: number;
  period: PeriodWindow;
  campaignCreatedAt: Date;
  campaignArchivedAt?: Date | null;
}): number {
  const daily = postsPerDay(args.dailyVideos);
  if (daily === 0) return 0;
  const clamped = clampPeriodToCampaign(
    args.period,
    args.campaignCreatedAt,
    args.campaignArchivedAt ?? null,
  );
  if (!clamped) return 0;
  return daily * countPeriodDays(clamped.start, clamped.end);
}

/** The flat day count of a MONTH projection (module docstring). */
export const MONTH_PROJECTION_DAYS = 30;

/**
 * maxPosts for a MONTH: dailyVideos × 30 when the deal existed at some point
 * of the month, else 0. Same dailyVideos clamp as maxPostsForPeriod.
 */
export function maxPostsForMonth(args: {
  dailyVideos: number;
  period: PeriodWindow;
  campaignCreatedAt: Date;
  campaignArchivedAt?: Date | null;
}): number {
  const inScope = clampPeriodToCampaign(
    args.period,
    args.campaignCreatedAt,
    args.campaignArchivedAt ?? null,
  );
  if (!inScope) return 0;
  return postsPerDay(args.dailyVideos) * MONTH_PROJECTION_DAYS;
}

/**
 * Spread a MONTH's flat-30 projection over its chart buckets so the weekly
 * bars sum to the headline exactly. Each deal's own total is spread over the
 * whole days it existed in each bucket (clampPeriodToCampaign), so no bar
 * shows income for a week before a deal was created or after it was
 * archived. A deal that existed for under a day weights the buckets it
 * touches equally. Each value is the difference of cumulative cent-rounded
 * shares, so rounding never leaks a cent between the bars and the total.
 */
export function spreadMonthTotal(
  buckets: readonly PeriodWindow[],
  lines: readonly {
    projected: Decimal;
    campaignCreatedAt: Date;
    campaignArchivedAt?: Date | null;
  }[],
): Decimal[] {
  const raw = buckets.map(() => new Decimal(0));
  for (const line of lines) {
    if (line.projected.lte(0)) continue;
    const spans = buckets.map((b) =>
      clampPeriodToCampaign(b, line.campaignCreatedAt, line.campaignArchivedAt ?? null),
    );
    let weights = spans.map((c) => (c ? countPeriodDays(c.start, c.end) : 0));
    if (weights.every((w) => w === 0)) weights = spans.map((c) => (c ? 1 : 0));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    weights.forEach((w, i) => {
      raw[i] = raw[i].plus(line.projected.times(w).div(total));
    });
  }
  let cum = new Decimal(0);
  let prev = new Decimal(0);
  return raw.map((r) => {
    cum = cum.plus(r);
    const upTo = cum.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const share = upTo.minus(prev);
    prev = upTo;
    return share;
  });
}

/**
 * Projected earnings for a period: maxPosts × base pay, in Decimal.
 * A null base pay (no base-pay component on the deal) projects $0 — CPM and
 * bonuses are deliberately excluded (module docstring). Accepts a plain
 * number alongside Decimal (lib/money MaybeDecimal convention) so
 * partially-mocked campaign shapes behave like real Decimal columns.
 */
export function projectedEarnings(
  basePayPerPost: Decimal | number | null,
  maxPosts: number,
): Decimal {
  if (basePayPerPost === null || maxPosts <= 0) return new Decimal(0);
  return new Decimal(basePayPerPost).times(maxPosts);
}

/** Default chart-bucket length: one week, matching the earnings trend chart. */
export const BUCKET_DAYS = 7;

/**
 * Tile a period into consecutive `bucketDays`-long windows, anchored at the
 * period's start (the user's local period-start instant), each ending 1ms
 * before the next begins — the module's end-of-period convention. The LAST
 * bucket clamps to the period's end, so a 30-day month tiles 7/7/7/7/2.
 *
 * Exact-millisecond math (like the rest of this module): a DST transition
 * inside a bucket shifts its local wall-clock boundary by the DST delta —
 * acceptable for a display-only chart series (same documented trade-off the
 * old trailing-window math made).
 *
 * Returns [] for an empty/inverted period.
 */
export function tileBucketWindows(
  period: PeriodWindow,
  bucketDays: number = BUCKET_DAYS,
): PeriodWindow[] {
  if (!Number.isFinite(bucketDays) || bucketDays < 1) return [];
  const len = Math.floor(bucketDays) * DAY_MS;
  const endMs = period.end.getTime();
  if (endMs < period.start.getTime()) return [];
  const windows: PeriodWindow[] = [];
  for (let startMs = period.start.getTime(); startMs <= endMs; startMs += len) {
    windows.push({
      start: new Date(startMs),
      end: new Date(Math.min(startMs + len - 1, endMs)),
    });
  }
  return windows;
}

/** The per-campaign inputs the bucket projection needs. */
export interface BucketProjectionLine {
  /** Campaign.dailyVideos — the documented maxPosts/day source. */
  dailyVideos: number;
  /** Override-resolved base pay per post (null = no base-pay component). */
  basePayPerPost: Decimal | number | null;
  campaignCreatedAt: Date;
  campaignArchivedAt?: Date | null;
}

/**
 * The chart's projected series: for each bucket, Σ over campaigns of
 * dailyVideos × basePayPerPost × days the campaign existed within the bucket
 * — the EXACT maxPostsForPeriod semantics (creation clamp + inclusive-day
 * count), prorated per bucket. Zero campaigns → a $0 Decimal per bucket.
 *
 * Returns Decimals positionally matching `buckets`; the caller applies the
 * single roundCents at the API boundary.
 */
export function projectedPerBucket(
  buckets: readonly PeriodWindow[],
  lines: readonly BucketProjectionLine[],
): Decimal[] {
  return buckets.map((bucket) =>
    lines.reduce(
      (sum, line) =>
        sum.plus(
          projectedEarnings(
            line.basePayPerPost,
            maxPostsForPeriod({
              dailyVideos: line.dailyVideos,
              period: bucket,
              campaignCreatedAt: line.campaignCreatedAt,
              campaignArchivedAt: line.campaignArchivedAt,
            }),
          ),
        ),
      new Decimal(0),
    ),
  );
}
