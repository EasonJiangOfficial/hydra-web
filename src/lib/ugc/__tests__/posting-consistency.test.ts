/**
 * Unit tests for the posting-consistency aggregator.
 *
 * Exercises `buildConsistencyResponse` directly so we don't need a
 * database or session — the aggregator is the entire interesting half
 * of the route. The two scenarios specifically called out by the bug
 * report:
 *
 *   (a) Same content fanned out to multiple platforms on the same day
 *       must NOT inflate the day count beyond the number of distinct
 *       platforms that actually fired.
 *   (b) Posting multiple times to the SAME platform on the same day
 *       still counts as 1 for that platform (de-dup), so the cell
 *       intensity reflects platform coverage, not raw row count.
 */
import { describe, it, expect } from "vitest";
import {
  buildConsistencyResponse,
  type PlatformPostRow,
} from "@/lib/ugc/posting-consistency";

// Window helper — anchors the test "now" so date math is deterministic.
function makeWindow(now: Date, windowDays: number): {
  since: Date;
  now: Date;
} {
  const since = new Date(now);
  since.setDate(since.getDate() - windowDays + 1);
  since.setHours(0, 0, 0, 0);
  return { since, now };
}

function at(year: number, month: number, day: number, hour = 12): Date {
  // Month is 1-indexed for readability; JS Date expects 0-indexed.
  return new Date(year, month - 1, day, hour, 0, 0, 0);
}

describe("buildConsistencyResponse", () => {
  const NOW = at(2026, 5, 27);
  const { since, now } = makeWindow(NOW, 30); // 30-day window for tighter tests

  it("counts cross-platform posts as the number of distinct platforms per day", () => {
    // Same day, three platforms — should surface as count: 3, total: 3.
    const rows: PlatformPostRow[] = [
      { postedAt: at(2026, 5, 20, 9), platform: "INSTAGRAM" },
      { postedAt: at(2026, 5, 20, 10), platform: "TIKTOK" },
      { postedAt: at(2026, 5, 20, 11), platform: "YOUTUBE" },
    ];

    const result = buildConsistencyResponse(rows, since, now, 30);
    const day = result.days.find((d) => d.date === "2026-05-20");
    expect(day).toBeDefined();
    expect(day?.count).toBe(3);
    expect(result.totalPosts).toBe(3);
    expect(result.longestStreak).toBe(1);
  });

  it("dedupes same-platform-same-day repeats (one IG post twice = 1)", () => {
    // Three Instagram posts on one day + one TikTok the next day.
    // Day 1: count 1 (Instagram). Day 2: count 1 (TikTok). total = 2.
    const rows: PlatformPostRow[] = [
      { postedAt: at(2026, 5, 20, 9), platform: "INSTAGRAM" },
      { postedAt: at(2026, 5, 20, 13), platform: "INSTAGRAM" },
      { postedAt: at(2026, 5, 20, 18), platform: "INSTAGRAM" },
      { postedAt: at(2026, 5, 21, 10), platform: "TIKTOK" },
    ];

    const result = buildConsistencyResponse(rows, since, now, 30);
    const d1 = result.days.find((d) => d.date === "2026-05-20");
    const d2 = result.days.find((d) => d.date === "2026-05-21");
    expect(d1?.count).toBe(1);
    expect(d2?.count).toBe(1);
    expect(result.totalPosts).toBe(2);
    expect(result.longestStreak).toBe(2);
  });

  it("treats every active day equally for streaks regardless of platform count", () => {
    // 3 consecutive days. Day 1: 3 platforms. Day 2: 1 platform. Day 3: 2.
    // Streaks must count 3 days, not 6 (platform-weighted).
    const rows: PlatformPostRow[] = [
      { postedAt: at(2026, 5, 25, 9), platform: "INSTAGRAM" },
      { postedAt: at(2026, 5, 25, 10), platform: "TIKTOK" },
      { postedAt: at(2026, 5, 25, 11), platform: "YOUTUBE" },
      { postedAt: at(2026, 5, 26, 9), platform: "INSTAGRAM" },
      { postedAt: at(2026, 5, 27, 9), platform: "INSTAGRAM" },
      { postedAt: at(2026, 5, 27, 10), platform: "TIKTOK" },
    ];

    const result = buildConsistencyResponse(rows, since, now, 30);
    expect(result.longestStreak).toBe(3);
    expect(result.currentStreak).toBe(3);
    // Sum of per-day platform counts: 3 + 1 + 2 = 6.
    expect(result.totalPosts).toBe(6);
  });

  it("returns the full window with zero-count days when nothing was posted", () => {
    const result = buildConsistencyResponse([], since, now, 30);
    expect(result.days).toHaveLength(30);
    expect(result.days.every((d) => d.count === 0)).toBe(true);
    expect(result.totalPosts).toBe(0);
    expect(result.currentStreak).toBe(0);
    expect(result.longestStreak).toBe(0);
  });

  it("ignores posts older than the window's start date", () => {
    // Two posts: one inside the window (kept), one before the window (dropped).
    const rows: PlatformPostRow[] = [
      { postedAt: at(2026, 5, 26, 9), platform: "INSTAGRAM" },
      // 60 days before NOW — outside the 30-day window.
      { postedAt: at(2026, 3, 28, 9), platform: "TIKTOK" },
    ];

    const result = buildConsistencyResponse(rows, since, now, 30);
    expect(result.totalPosts).toBe(1);
    const kept = result.days.find((d) => d.date === "2026-05-26");
    expect(kept?.count).toBe(1);
  });

  it("counts today even when no post has fired yet (streak anchors on yesterday)", () => {
    // Posted yesterday + day before. Nothing today. Current streak = 2.
    const rows: PlatformPostRow[] = [
      { postedAt: at(2026, 5, 25, 9), platform: "INSTAGRAM" },
      { postedAt: at(2026, 5, 26, 9), platform: "INSTAGRAM" },
    ];

    const result = buildConsistencyResponse(rows, since, now, 30);
    expect(result.currentStreak).toBe(2);
  });
});
