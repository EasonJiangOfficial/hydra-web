/**
 * Hand-computed tests for the Projected income math
 * (lib/finances/projection.ts — display-only, never feeds payouts).
 *
 * Every expected number below is computed by hand in the comment next to it.
 * Covers: period day counts (incl. DST-ish offsets and the end-of-day −1ms
 * convention), campaign-existence proration (partial periods), the
 * dailyVideos × days × basePay formula, override-adjusted base pay (Decimal
 * passthrough), the chart-bucket tiling (tileBucketWindows) and the
 * per-bucket projected series (projectedPerBucket) — partial buckets,
 * campaigns created mid-bucket, multiple campaigns, zero campaigns.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  BUCKET_DAYS,
  countPeriodDays,
  clampPeriodToCampaign,
  MONTH_PROJECTION_DAYS,
  maxPostsForMonth,
  maxPostsForPeriod,
  projectedEarnings,
  projectedPerBucket,
  spreadMonthTotal,
  tileBucketWindows,
  type PeriodWindow,
} from "@/lib/ugc/projection";

const D = (s: string) => new Date(s);
const dec = (v: number | string) => new Decimal(v);

/** endOfDay-style window helper: [start 00:00, end 23:59:59.999] UTC. */
function win(startDay: string, endDay: string): PeriodWindow {
  return {
    start: D(`${startDay}T00:00:00.000Z`),
    end: D(`${endDay}T23:59:59.999Z`),
  };
}

// ── countPeriodDays ──────────────────────────────────────────────────────────

describe("countPeriodDays", () => {
  it("a single day (startOfDay → endOfDay) counts 1", () => {
    const w = win("2026-06-10", "2026-06-10");
    expect(countPeriodDays(w.start, w.end)).toBe(1);
  });

  it("a full 30-day month (June) counts 30", () => {
    const w = win("2026-06-01", "2026-06-30");
    expect(countPeriodDays(w.start, w.end)).toBe(30);
  });

  it("a full 31-day month (May) counts 31", () => {
    const w = win("2026-05-01", "2026-05-31");
    expect(countPeriodDays(w.start, w.end)).toBe(31);
  });

  it("a calendar week counts 7", () => {
    const w = win("2026-06-07", "2026-06-13"); // Sun → Sat
    expect(countPeriodDays(w.start, w.end)).toBe(7);
  });

  it("a leap-year February counts 29", () => {
    const w = win("2028-02-01", "2028-02-29");
    expect(countPeriodDays(w.start, w.end)).toBe(29);
  });

  it("absorbs a +1h DST (fall-back) stretch without over-counting", () => {
    // 31 days + 1 extra hour (a local-time October with fall-back) → 31.
    const start = D("2026-10-01T00:00:00.000Z");
    const end = new Date(
      start.getTime() + 31 * 24 * 3600 * 1000 + 3600 * 1000 - 1,
    );
    expect(countPeriodDays(start, end)).toBe(31);
  });

  it("absorbs a −1h DST (spring-forward) stretch without under-counting", () => {
    // 30 days − 1 hour → still 30.
    const start = D("2026-03-01T00:00:00.000Z");
    const end = new Date(
      start.getTime() + 30 * 24 * 3600 * 1000 - 3600 * 1000 - 1,
    );
    expect(countPeriodDays(start, end)).toBe(30);
  });

  it("returns 0 for an empty / inverted window", () => {
    const w = win("2026-06-10", "2026-06-10");
    expect(countPeriodDays(w.end, w.start)).toBe(0);
  });
});

// ── clampPeriodToCampaign (partial periods) ──────────────────────────────────

describe("clampPeriodToCampaign", () => {
  const june = win("2026-06-01", "2026-06-30");

  it("campaign older than the period → unchanged window", () => {
    const clamped = clampPeriodToCampaign(june, D("2026-01-05T12:00:00Z"));
    expect(clamped).toEqual(june);
  });

  it("campaign created mid-period → window starts at creation (partial period)", () => {
    const createdAt = D("2026-06-20T08:30:00Z");
    const clamped = clampPeriodToCampaign(june, createdAt);
    expect(clamped).toEqual({ start: createdAt, end: june.end });
  });

  it("campaign created after the period → null (no overlap)", () => {
    expect(clampPeriodToCampaign(june, D("2026-07-01T00:00:00Z"))).toBeNull();
  });
});

// ── maxPostsForPeriod — THE documented formula ───────────────────────────────

describe("maxPostsForPeriod", () => {
  const june = win("2026-06-01", "2026-06-30");

  it("dailyVideos 2 × 30-day June = 60", () => {
    expect(
      maxPostsForPeriod({
        dailyVideos: 2,
        period: june,
        campaignCreatedAt: D("2026-01-01T00:00:00Z"),
      }),
    ).toBe(60);
  });

  it("dailyVideos 1 × one day = 1", () => {
    expect(
      maxPostsForPeriod({
        dailyVideos: 1,
        period: win("2026-06-10", "2026-06-10"),
        campaignCreatedAt: D("2026-01-01T00:00:00Z"),
      }),
    ).toBe(1);
  });

  it("prorates a partial period: created Jun 20 08:30 → Jun 20..30 ≈ 11 days × 3 = 33", () => {
    // Window after clamp: [Jun 20 08:30, Jun 30 23:59:59.999] = 10.64 days
    // → rounds to 11 inclusive calendar days. 11 × 3 = 33.
    expect(
      maxPostsForPeriod({
        dailyVideos: 3,
        period: june,
        campaignCreatedAt: D("2026-06-20T08:30:00Z"),
      }),
    ).toBe(33);
  });

  it("campaign created after the period → 0", () => {
    expect(
      maxPostsForPeriod({
        dailyVideos: 5,
        period: june,
        campaignCreatedAt: D("2026-07-04T00:00:00Z"),
      }),
    ).toBe(0);
  });

  it("dailyVideos 0 → 0 (no cadence, no projection)", () => {
    expect(
      maxPostsForPeriod({
        dailyVideos: 0,
        period: june,
        campaignCreatedAt: D("2026-01-01T00:00:00Z"),
      }),
    ).toBe(0);
  });

  it("negative / NaN dailyVideos clamp to 0, never negative", () => {
    expect(
      maxPostsForPeriod({
        dailyVideos: -4,
        period: june,
        campaignCreatedAt: D("2026-01-01T00:00:00Z"),
      }),
    ).toBe(0);
    expect(
      maxPostsForPeriod({
        dailyVideos: Number.NaN,
        period: june,
        campaignCreatedAt: D("2026-01-01T00:00:00Z"),
      }),
    ).toBe(0);
  });

  it("fractional dailyVideos floors (2.9 → 2): 2 × 30 = 60", () => {
    expect(
      maxPostsForPeriod({
        dailyVideos: 2.9,
        period: june,
        campaignCreatedAt: D("2026-01-01T00:00:00Z"),
      }),
    ).toBe(60);
  });
});

// ── projectedEarnings ────────────────────────────────────────────────────────

describe("projectedEarnings", () => {
  it("60 posts × $25.50 = $1,530.00 exactly", () => {
    expect(projectedEarnings(dec("25.50"), 60).toString()).toBe("1530");
  });

  it("Decimal exactness: 3 × $0.10 = $0.30 (no float drift)", () => {
    expect(projectedEarnings(dec("0.10"), 3).toString()).toBe("0.3");
  });

  it("override-adjusted base pay flows through untouched: 14 × $32.75 = $458.50", () => {
    // Simulates resolveEffectivePayFields output (override.paymentPerVideo).
    expect(projectedEarnings(dec("32.75"), 14).toString()).toBe("458.5");
  });

  it("null base pay (no base-pay component) → $0", () => {
    expect(projectedEarnings(null, 60).toString()).toBe("0");
  });

  it("zero maxPosts → $0", () => {
    expect(projectedEarnings(dec(25), 0).toString()).toBe("0");
  });
});

// ── tileBucketWindows — the chart x-axis ─────────────────────────────────────

describe("tileBucketWindows", () => {
  it("June 2026 (30 days) tiles into 7/7/7/7/2-day weekly buckets", () => {
    const buckets = tileBucketWindows(win("2026-06-01", "2026-06-30"));
    expect(BUCKET_DAYS).toBe(7);
    expect(buckets).toHaveLength(5);
    expect(buckets[0].start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(buckets[0].end.toISOString()).toBe("2026-06-07T23:59:59.999Z");
    expect(buckets[1].start.toISOString()).toBe("2026-06-08T00:00:00.000Z");
    expect(buckets[3].end.toISOString()).toBe("2026-06-28T23:59:59.999Z");
    // The final PARTIAL bucket clamps to the period end (Jun 29–30: 2 days).
    expect(buckets[4].start.toISOString()).toBe("2026-06-29T00:00:00.000Z");
    expect(buckets[4].end.toISOString()).toBe("2026-06-30T23:59:59.999Z");
    const days = buckets.map((b) => countPeriodDays(b.start, b.end));
    expect(days).toEqual([7, 7, 7, 7, 2]);
  });

  it("buckets tile contiguously: each ends 1ms before the next begins", () => {
    const buckets = tileBucketWindows(win("2026-06-01", "2026-06-30"));
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i - 1].end.getTime() + 1).toBe(
        buckets[i].start.getTime(),
      );
    }
  });

  it("an exactly-7-day period yields ONE full bucket", () => {
    const buckets = tileBucketWindows(win("2026-06-07", "2026-06-13"));
    expect(buckets).toHaveLength(1);
    expect(countPeriodDays(buckets[0].start, buckets[0].end)).toBe(7);
  });

  it("a single-day period yields one 1-day bucket (single-point chart)", () => {
    const buckets = tileBucketWindows(win("2026-06-10", "2026-06-10"));
    expect(buckets).toHaveLength(1);
    expect(countPeriodDays(buckets[0].start, buckets[0].end)).toBe(1);
  });

  it("a 365-day year tiles into 52 full weeks + a 1-day remainder", () => {
    const buckets = tileBucketWindows(win("2026-01-01", "2026-12-31"));
    expect(buckets).toHaveLength(53);
    expect(countPeriodDays(buckets[52].start, buckets[52].end)).toBe(1);
  });

  it("respects a custom bucket length (3-day window, 1-day buckets)", () => {
    const buckets = tileBucketWindows(win("2026-06-01", "2026-06-03"), 1);
    expect(buckets).toHaveLength(3);
    for (const b of buckets) expect(countPeriodDays(b.start, b.end)).toBe(1);
  });

  it("returns [] for an inverted period or a nonsense bucket length", () => {
    expect(
      tileBucketWindows({
        start: D("2026-06-10T00:00:00Z"),
        end: D("2026-06-01T00:00:00Z"),
      }),
    ).toEqual([]);
    expect(tileBucketWindows(win("2026-06-01", "2026-06-30"), 0)).toEqual([]);
    expect(
      tileBucketWindows(win("2026-06-01", "2026-06-30"), Number.NaN),
    ).toEqual([]);
  });
});

// ── projectedPerBucket — the chart's projected series ────────────────────────

describe("projectedPerBucket", () => {
  const JUNE = win("2026-06-01", "2026-06-30");
  const juneBuckets = tileBucketWindows(JUNE); // 7/7/7/7/2 days

  it("one long-lived campaign: dailyVideos 2 × $25 → 350/350/350/350/100", () => {
    const series = projectedPerBucket(juneBuckets, [
      {
        dailyVideos: 2,
        basePayPerPost: dec(25),
        campaignCreatedAt: D("2026-01-01T00:00:00Z"),
      },
    ]);
    expect(series.map((d) => d.toNumber())).toEqual([350, 350, 350, 350, 100]);
    // Bucket sum === the whole-period projection (2 × 30 × $25 = $1,500).
    const total = series.reduce((s, d) => s.plus(d), dec(0));
    expect(total.toString()).toBe("1500");
  });

  it("campaign created MID-bucket prorates that bucket only (Jun 20 08:30, 3/day, $10)", () => {
    // Bucket 3 (Jun 15–21) clamps to [Jun 20 08:30, Jun 21 end] ≈ 1.65 days
    // → 2 inclusive days → 6 posts → $60. Bucket 4: 7 days → 21 → $210.
    // Bucket 5 (Jun 29–30): 2 days → 6 → $60. Earlier buckets: $0.
    const series = projectedPerBucket(juneBuckets, [
      {
        dailyVideos: 3,
        basePayPerPost: dec(10),
        campaignCreatedAt: D("2026-06-20T08:30:00Z"),
      },
    ]);
    expect(series.map((d) => d.toNumber())).toEqual([0, 0, 60, 210, 60]);
    // Reconciles with the whole-period maxPosts (11 days × 3 = 33 → $330).
    const total = series.reduce((s, d) => s.plus(d), dec(0));
    expect(total.toString()).toBe("330");
  });

  it("multiple campaigns sum per bucket (hand-computed composition)", () => {
    // A: 1/day × $25, created long ago → 175/175/175/175/50.
    // B: 2/day × $40, created Jun 16 00:00 →
    //    bucket 3 (Jun 15–21) clamps to Jun 16–21 = 6 days → 12 posts → 480;
    //    bucket 4: 14 posts → 560; bucket 5: 4 posts → 160; earlier: 0.
    const series = projectedPerBucket(juneBuckets, [
      {
        dailyVideos: 1,
        basePayPerPost: dec(25),
        campaignCreatedAt: D("2026-01-01T00:00:00Z"),
      },
      {
        dailyVideos: 2,
        basePayPerPost: dec(40),
        campaignCreatedAt: D("2026-06-16T00:00:00Z"),
      },
    ]);
    expect(series.map((d) => d.toNumber())).toEqual([
      175,
      175,
      175 + 480,
      175 + 560,
      50 + 160,
    ]);
    // Totals: A $750 + B $1,200 = $1,950 — matches the headline totals.
    const total = series.reduce((s, d) => s.plus(d), dec(0));
    expect(total.toString()).toBe("1950");
  });

  it("zero campaigns → a $0 Decimal for every bucket", () => {
    const series = projectedPerBucket(juneBuckets, []);
    expect(series).toHaveLength(juneBuckets.length);
    for (const d of series) expect(d.toString()).toBe("0");
  });

  it("null base pay contributes $0 without disturbing other campaigns", () => {
    const series = projectedPerBucket(juneBuckets, [
      {
        dailyVideos: 4,
        basePayPerPost: null,
        campaignCreatedAt: D("2026-01-01T00:00:00Z"),
      },
      {
        dailyVideos: 1,
        basePayPerPost: dec(10),
        campaignCreatedAt: D("2026-01-01T00:00:00Z"),
      },
    ]);
    expect(series.map((d) => d.toNumber())).toEqual([70, 70, 70, 70, 20]);
  });

  it("keeps Decimal exactness per bucket (7 × $0.10 = $0.70, no float drift)", () => {
    const series = projectedPerBucket(juneBuckets, [
      {
        dailyVideos: 1,
        basePayPerPost: dec("0.10"),
        campaignCreatedAt: D("2026-01-01T00:00:00Z"),
      },
    ]);
    expect(series[0].toString()).toBe("0.7");
    expect(series[4].toString()).toBe("0.2");
  });

  it("no buckets → no series", () => {
    expect(
      projectedPerBucket([], [
        {
          dailyVideos: 1,
          basePayPerPost: dec(10),
          campaignCreatedAt: D("2026-01-01T00:00:00Z"),
        },
      ]),
    ).toEqual([]);
  });
});

// Owner, 2026-10-21: "it should be doing base pay * vid target * 30 days".
describe("maxPostsForMonth — a flat 30 days", () => {
  const OCT = win("2026-10-01", "2026-10-31");
  const FEB = win("2027-02-01", "2027-02-28");

  it("is dailyVideos × 30 whatever the month's length", () => {
    expect(MONTH_PROJECTION_DAYS).toBe(30);
    const args = { dailyVideos: 5, campaignCreatedAt: D("2026-01-01T00:00:00Z") };
    expect(maxPostsForMonth({ ...args, period: OCT })).toBe(150);
    expect(maxPostsForMonth({ ...args, period: FEB })).toBe(150);
  });

  it("ignores a mid-month start or archive (no proration)", () => {
    expect(
      maxPostsForMonth({ dailyVideos: 5, period: OCT, campaignCreatedAt: D("2026-10-07T15:00:00Z") }),
    ).toBe(150);
    expect(
      maxPostsForMonth({
        dailyVideos: 5,
        period: OCT,
        campaignCreatedAt: D("2026-01-01T00:00:00Z"),
        campaignArchivedAt: D("2026-10-10T00:00:00Z"),
      }),
    ).toBe(150);
  });

  it("is 0 for a deal outside the month or with no cadence", () => {
    // Created after the month ended.
    expect(maxPostsForMonth({ dailyVideos: 5, period: OCT, campaignCreatedAt: D("2026-11-02T00:00:00Z") })).toBe(0);
    // Archived before the month began.
    expect(
      maxPostsForMonth({
        dailyVideos: 5,
        period: OCT,
        campaignCreatedAt: D("2026-01-01T00:00:00Z"),
        campaignArchivedAt: D("2026-09-20T00:00:00Z"),
      }),
    ).toBe(0);
    expect(maxPostsForMonth({ dailyVideos: 0, period: OCT, campaignCreatedAt: D("2026-01-01T00:00:00Z") })).toBe(0);
    expect(maxPostsForMonth({ dailyVideos: NaN, period: OCT, campaignCreatedAt: D("2026-01-01T00:00:00Z") })).toBe(0);
  });
});

describe("spreadMonthTotal", () => {
  const OLD = D("2026-01-01T00:00:00Z");
  const line = (projected: number, createdAt = OLD, archivedAt: Date | null = null) => ({
    projected: dec(projected),
    campaignCreatedAt: createdAt,
    campaignArchivedAt: archivedAt,
  });

  it("June (30 days, 7/7/7/7/2) spreads $900 as 210/210/210/210/60", () => {
    const june = win("2026-06-01", "2026-06-30");
    const out = spreadMonthTotal(tileBucketWindows(june), [line(900)]);
    expect(out.map((d) => d.toNumber())).toEqual([210, 210, 210, 210, 60]);
  });

  it("never puts a deal's projection in weeks before it was created or after it was archived", () => {
    const june = win("2026-06-01", "2026-06-30");
    // Created Jun 20: exists 2/7/2 whole days in the last three buckets (11).
    const young = spreadMonthTotal(tileBucketWindows(june), [line(900, D("2026-06-20T08:30:00Z"))]);
    expect(young.map((d) => d.toNumber())).toEqual([0, 0, 163.64, 572.72, 163.64]);
    // Archived Jun 10 (00:00): Jun 1-7 (7 days) + Jun 8-9 (2 days, rounded).
    const gone = spreadMonthTotal(tileBucketWindows(june), [line(900, OLD, D("2026-06-10T00:00:00Z"))]);
    expect(gone.map((d) => d.toNumber())).toEqual([700, 200, 0, 0, 0]);
    // Two deals: each spread over its own days, summed.
    const both = spreadMonthTotal(tileBucketWindows(june), [line(900), line(900, D("2026-06-20T08:30:00Z"))]);
    expect(both.reduce((s, d) => s.plus(d), dec(0)).toNumber()).toBe(1800);
    expect(both[0].toNumber()).toBe(210);
  });

  it("a deal that existed for under a day still lands its whole total in the bars", () => {
    const june = win("2026-06-01", "2026-06-30");
    const out = spreadMonthTotal(tileBucketWindows(june), [line(900, D("2026-06-30T23:00:00Z"))]);
    expect(out.map((d) => d.toNumber())).toEqual([0, 0, 0, 0, 900]);
  });

  it("sums to the total to the cent when shares are not whole cents", () => {
    // $100 over October's 31 days: 7/31 of $100 = $22.580645…
    const oct = win("2026-10-01", "2026-10-31");
    const out = spreadMonthTotal(tileBucketWindows(oct), [line(100)]);
    // Cumulative: 22.58, 45.16, 67.74, 90.32, 100.00.
    expect(out.map((d) => d.toNumber())).toEqual([22.58, 22.58, 22.58, 22.58, 9.68]);
    expect(out.reduce((s, d) => s.plus(d), dec(0)).toNumber()).toBe(100);
  });
});
