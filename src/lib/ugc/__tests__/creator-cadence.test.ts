/**
 * Unit tests for the pure cadence aggregation (lib/brand/creator-cadence.ts).
 *
 * Focus areas (heavy):
 *   - day bucketing is timezone-CORRECT (UTC), incl. 23:30Z / 00:30Z edges that
 *     a local-clock implementation would mis-bucket
 *   - continuous zero-filled day grid over the inclusive range
 *   - posts outside the range are ignored
 *   - posts-per-week (Mon-anchored, ISO) + posts-per-month rollups
 *   - summary: total / active days / busiest day / averages
 *   - empty input (no-posts creator)
 *   - resolveDateRange presets (today / day / week / month) boundaries
 *   - isWithinRange boundary inclusivity (start 00:00:00.000Z, end 23:59:59.999Z)
 *   - day-key + preset validation
 */
import { describe, it, expect } from "vitest";
import {
  buildCadence,
  resolveDateRange,
  isWithinRange,
  isValidDayKey,
  parsePreset,
  toUtcDayKey,
  toUtcMonthKey,
  utcWeekStartKey,
  type CadencePost,
} from "@/lib/ugc/creator-cadence";

function post(iso: string): CadencePost {
  return { postedAt: new Date(iso) };
}

describe("toUtcDayKey / toUtcMonthKey", () => {
  it("derives the UTC day/month key regardless of local clock", () => {
    expect(toUtcDayKey(new Date("2026-03-15T23:30:00Z"))).toBe("2026-03-15");
    expect(toUtcDayKey(new Date("2026-03-16T00:30:00Z"))).toBe("2026-03-16");
    expect(toUtcMonthKey(new Date("2026-03-31T23:59:59Z"))).toBe("2026-03");
  });
});

describe("utcWeekStartKey (Monday-anchored ISO week)", () => {
  it("anchors to Monday for every weekday", () => {
    // 2026-06-08 is a Monday.
    expect(utcWeekStartKey("2026-06-08")).toBe("2026-06-08"); // Mon → itself
    expect(utcWeekStartKey("2026-06-09")).toBe("2026-06-08"); // Tue
    expect(utcWeekStartKey("2026-06-14")).toBe("2026-06-08"); // Sun → same week
    expect(utcWeekStartKey("2026-06-15")).toBe("2026-06-15"); // next Mon
  });

  it("handles a Sunday correctly (does not roll into next week)", () => {
    expect(utcWeekStartKey("2026-06-07")).toBe("2026-06-01"); // Sun → prev Mon
  });
});

describe("buildCadence — day bucketing", () => {
  const start = new Date("2026-06-01T00:00:00Z");
  const end = new Date("2026-06-07T12:00:00Z");

  it("buckets posts to the correct UTC day, including 23:30Z / 00:30Z edges", () => {
    const posts = [
      post("2026-06-03T23:30:00Z"), // late on the 3rd (UTC) — must stay on 06-03
      post("2026-06-04T00:30:00Z"), // early on the 4th — must stay on 06-04
      post("2026-06-04T10:00:00Z"), // also the 4th
    ];
    const c = buildCadence(posts, start, end);
    const map = Object.fromEntries(c.days.map((d) => [d.date, d.count]));
    expect(map["2026-06-03"]).toBe(1);
    expect(map["2026-06-04"]).toBe(2);
  });

  it("produces a continuous zero-filled inclusive day grid", () => {
    const c = buildCadence([], start, end);
    expect(c.days[0].date).toBe("2026-06-01");
    expect(c.days[c.days.length - 1].date).toBe("2026-06-07");
    expect(c.days).toHaveLength(7);
    expect(c.days.every((d) => d.count === 0)).toBe(true);
  });

  it("ignores posts outside the inclusive range", () => {
    const posts = [
      post("2026-05-31T23:59:00Z"), // day before range
      post("2026-06-08T00:00:00Z"), // day after range
      post("2026-06-02T08:00:00Z"), // in range
    ];
    const c = buildCadence(posts, start, end);
    expect(c.summary.totalPosts).toBe(1);
    expect(c.days.find((d) => d.date === "2026-06-02")?.count).toBe(1);
  });
});

describe("buildCadence — week + month rollups", () => {
  it("rolls posts into Mon-anchored weeks", () => {
    // Range spans two ISO weeks: Mon 06-01..Sun 06-07, then Mon 06-08..
    const start = new Date("2026-06-01T00:00:00Z");
    const end = new Date("2026-06-10T00:00:00Z");
    const posts = [
      post("2026-06-02T00:00:00Z"), // week of 06-01
      post("2026-06-07T00:00:00Z"), // Sun → still week of 06-01
      post("2026-06-08T00:00:00Z"), // Mon → week of 06-08
      post("2026-06-09T00:00:00Z"), // week of 06-08
    ];
    const c = buildCadence(posts, start, end);
    const wk = Object.fromEntries(c.weeks.map((w) => [w.weekStart, w.count]));
    expect(wk["2026-06-01"]).toBe(2);
    expect(wk["2026-06-08"]).toBe(2);
  });

  it("rolls posts into calendar months across a boundary", () => {
    const start = new Date("2026-05-30T00:00:00Z");
    const end = new Date("2026-06-02T00:00:00Z");
    const posts = [
      post("2026-05-30T00:00:00Z"),
      post("2026-05-31T00:00:00Z"),
      post("2026-06-01T00:00:00Z"),
    ];
    const c = buildCadence(posts, start, end);
    const m = Object.fromEntries(c.months.map((x) => [x.month, x.count]));
    expect(m["2026-05"]).toBe(2);
    expect(m["2026-06"]).toBe(1);
  });
});

describe("buildCadence — summary", () => {
  it("computes totals, active days, busiest day, and averages", () => {
    const start = new Date("2026-06-01T00:00:00Z");
    const end = new Date("2026-06-14T00:00:00Z"); // two full weeks
    const posts = [
      post("2026-06-01T00:00:00Z"),
      post("2026-06-01T06:00:00Z"),
      post("2026-06-01T12:00:00Z"), // busiest day: 06-01 with 3
      post("2026-06-09T00:00:00Z"),
    ];
    const c = buildCadence(posts, start, end);
    expect(c.summary.totalPosts).toBe(4);
    expect(c.summary.activeDays).toBe(2);
    expect(c.summary.busiestDay).toEqual({ date: "2026-06-01", count: 3 });
    // 4 posts / 2 weeks = 2 per week.
    expect(c.summary.avgPerWeek).toBe(2);
    // 4 posts / 1 month = 4 per month.
    expect(c.summary.avgPerMonth).toBe(4);
  });

  it("returns a clean empty summary for a no-posts creator", () => {
    const start = new Date("2026-06-01T00:00:00Z");
    const end = new Date("2026-06-07T00:00:00Z");
    const c = buildCadence([], start, end);
    expect(c.summary.totalPosts).toBe(0);
    expect(c.summary.activeDays).toBe(0);
    expect(c.summary.busiestDay).toBeNull();
    expect(c.summary.avgPerWeek).toBe(0);
    expect(c.days.every((d) => d.count === 0)).toBe(true);
  });
});

describe("resolveDateRange — presets (UTC boundaries)", () => {
  const now = new Date("2026-06-10T15:30:00Z"); // a Wednesday

  it("today → the UTC day containing now (00:00:00.000 → 23:59:59.999)", () => {
    const r = resolveDateRange("today", now);
    expect(r.start.toISOString()).toBe("2026-06-10T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-06-10T23:59:59.999Z");
  });

  it("day → the UTC day of an explicit dayKey", () => {
    const r = resolveDateRange("day", now, "2026-03-15");
    expect(r.start.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-03-15T23:59:59.999Z");
  });

  it("day → falls back to today when no dayKey is given", () => {
    const r = resolveDateRange("day", now, null);
    expect(toUtcDayKey(r.start)).toBe("2026-06-10");
  });

  it("week → Mon..Sun (UTC) ISO week containing now", () => {
    // 2026-06-10 is a Wednesday → week of Mon 2026-06-08 .. Sun 2026-06-14.
    const r = resolveDateRange("week", now);
    expect(r.start.toISOString()).toBe("2026-06-08T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-06-14T23:59:59.999Z");
  });

  it("month → first..last day (UTC) of the calendar month containing now", () => {
    const r = resolveDateRange("month", now);
    expect(r.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-06-30T23:59:59.999Z");
  });

  it("month → handles February length correctly", () => {
    const feb = new Date("2026-02-14T00:00:00Z");
    const r = resolveDateRange("month", feb);
    expect(r.end.toISOString()).toBe("2026-02-28T23:59:59.999Z");
  });
});

describe("isWithinRange — boundary inclusivity", () => {
  const now = new Date("2026-06-10T12:00:00Z");
  const r = resolveDateRange("today", now);

  it("includes a post at 00:00:00.000Z (start) and 23:59:59.999Z (end)", () => {
    expect(isWithinRange(new Date("2026-06-10T00:00:00.000Z"), r)).toBe(true);
    expect(isWithinRange(new Date("2026-06-10T23:59:59.999Z"), r)).toBe(true);
  });

  it("excludes a post one ms before start or after end", () => {
    expect(isWithinRange(new Date("2026-06-09T23:59:59.999Z"), r)).toBe(false);
    expect(isWithinRange(new Date("2026-06-11T00:00:00.000Z"), r)).toBe(false);
  });

  it("a 23:30Z post lands inside the day range (no TZ drift to next day)", () => {
    expect(isWithinRange(new Date("2026-06-10T23:30:00Z"), r)).toBe(true);
  });
});

describe("isValidDayKey / parsePreset", () => {
  it("accepts a valid calendar day key", () => {
    expect(isValidDayKey("2026-06-08")).toBe(true);
  });

  it("rejects malformed or impossible day keys", () => {
    expect(isValidDayKey("2026-6-8")).toBe(false);
    expect(isValidDayKey("2026-13-01")).toBe(false); // month 13
    expect(isValidDayKey("2026-02-30")).toBe(false); // Feb 30 doesn't exist
    expect(isValidDayKey("")).toBe(false);
    expect(isValidDayKey(null)).toBe(false);
    expect(isValidDayKey(undefined)).toBe(false);
  });

  it("narrows known presets and defaults unknown to month", () => {
    expect(parsePreset("today")).toBe("today");
    expect(parsePreset("day")).toBe("day");
    expect(parsePreset("week")).toBe("week");
    expect(parsePreset("month")).toBe("month");
    expect(parsePreset("bogus")).toBe("month");
    expect(parsePreset(null)).toBe("month");
  });
});
