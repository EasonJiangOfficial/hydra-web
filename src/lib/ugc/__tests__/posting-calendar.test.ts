/**
 * Unit tests for lib/brand/posting-calendar — the pure month-grid calendar
 * helpers (leaf module, no DB).
 *
 * Covers:
 *   - month-key validation (accepts "YYYY-MM", rejects garbage/13/00/dates)
 *   - prev/next month keys across year boundaries
 *   - clampMonthKey (history floor + current-month ceiling)
 *   - monthRangeUtc inclusivity + daysInUtcMonth (leap years)
 *   - buildMonthCalendar zero-seeding + stats (activeDays/totalPosts/peakDay)
 *   - display labels ("Jun 2026", "Jun 1", tooltip full date) in UTC
 *   - the 6-step intensity bucket scaling
 */
import { describe, it, expect } from "vitest";
import {
  MONTH_INTENSITY_STEPS,
  buildMonthCalendar,
  clampMonthKey,
  currentUtcMonthKey,
  daysInUtcMonth,
  formatMonthDayFull,
  formatMonthDayLabel,
  formatMonthHeading,
  isValidMonthKey,
  monthIntensityBucket,
  monthRangeUtc,
  nextMonthKey,
  prevMonthKey,
} from "@/lib/ugc/posting-calendar";

describe("posting-calendar · month keys", () => {
  it("accepts well-formed calendar months", () => {
    expect(isValidMonthKey("2026-01")).toBe(true);
    expect(isValidMonthKey("2026-12")).toBe(true);
    expect(isValidMonthKey("1999-06")).toBe(true);
  });

  it("rejects garbage, out-of-range and date-shaped keys", () => {
    expect(isValidMonthKey(null)).toBe(false);
    expect(isValidMonthKey(undefined)).toBe(false);
    expect(isValidMonthKey("")).toBe(false);
    expect(isValidMonthKey("garbage")).toBe(false);
    expect(isValidMonthKey("2026-13")).toBe(false);
    expect(isValidMonthKey("2026-00")).toBe(false);
    expect(isValidMonthKey("2026-6")).toBe(false);
    expect(isValidMonthKey("2026-06-01")).toBe(false);
  });

  it("currentUtcMonthKey reads the UTC month of the injected clock", () => {
    expect(currentUtcMonthKey(new Date("2026-06-09T23:30:00Z"))).toBe(
      "2026-06",
    );
    // 00:30 on July 1 UTC is still June in UTC-5 — UTC wins.
    expect(currentUtcMonthKey(new Date("2026-07-01T00:30:00Z"))).toBe(
      "2026-07",
    );
  });

  it("prev/next step one month and handle year boundaries", () => {
    expect(prevMonthKey("2026-06")).toBe("2026-05");
    expect(nextMonthKey("2026-06")).toBe("2026-07");
    expect(prevMonthKey("2026-01")).toBe("2025-12");
    expect(nextMonthKey("2025-12")).toBe("2026-01");
  });
});

describe("posting-calendar · clampMonthKey", () => {
  it("clamps below the first-activity floor and above the current ceiling", () => {
    expect(clampMonthKey("2024-01", "2025-03", "2026-06")).toBe("2025-03");
    expect(clampMonthKey("2027-01", "2025-03", "2026-06")).toBe("2026-06");
    expect(clampMonthKey("2025-12", "2025-03", "2026-06")).toBe("2025-12");
  });

  it("with no known history, only the current-month ceiling applies", () => {
    expect(clampMonthKey("2020-01", null, "2026-06")).toBe("2020-01");
    expect(clampMonthKey("2030-01", null, "2026-06")).toBe("2026-06");
  });

  it("a (bad-data) future first-activity month still respects the ceiling", () => {
    expect(clampMonthKey("2026-01", "2027-09", "2026-06")).toBe("2026-06");
  });
});

describe("posting-calendar · month range & size", () => {
  it("covers the full month inclusively in UTC", () => {
    const { start, end } = monthRangeUtc("2026-06");
    expect(start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-30T23:59:59.999Z");
  });

  it("handles December (year rollover for the end bound)", () => {
    const { end } = monthRangeUtc("2025-12");
    expect(end.toISOString()).toBe("2025-12-31T23:59:59.999Z");
  });

  it("daysInUtcMonth knows month lengths and leap years", () => {
    expect(daysInUtcMonth("2026-06")).toBe(30);
    expect(daysInUtcMonth("2026-07")).toBe(31);
    expect(daysInUtcMonth("2026-02")).toBe(28);
    expect(daysInUtcMonth("2028-02")).toBe(29); // leap
  });
});

describe("posting-calendar · buildMonthCalendar", () => {
  const at = (iso: string) => ({ postedAt: new Date(iso) });

  it("zero-seeds every day of an empty month", () => {
    const { days, stats } = buildMonthCalendar([], "2026-06");
    expect(days).toHaveLength(30);
    expect(days.every((d) => d.count === 0)).toBe(true);
    expect(stats).toEqual({ activeDays: 0, totalPosts: 0, peakDay: 0 });
  });

  it("buckets per UTC day and derives the footer stats", () => {
    const { days, stats } = buildMonthCalendar(
      [
        at("2026-06-08T01:00:00Z"),
        at("2026-06-08T23:30:00Z"), // same UTC day — no drift
        at("2026-06-10T12:00:00Z"),
      ],
      "2026-06",
    );
    expect(days.find((d) => d.date === "2026-06-08")?.count).toBe(2);
    expect(days.find((d) => d.date === "2026-06-09")?.count).toBe(0);
    expect(stats).toEqual({ activeDays: 2, totalPosts: 3, peakDay: 2 });
  });

  it("ignores posts outside the month (defensive)", () => {
    const { stats } = buildMonthCalendar(
      [at("2026-05-31T23:59:59Z"), at("2026-07-01T00:00:00Z")],
      "2026-06",
    );
    expect(stats.totalPosts).toBe(0);
  });
});

describe("posting-calendar · display labels (UTC)", () => {
  it("formats the month heading like the reference", () => {
    expect(formatMonthHeading("2026-06")).toBe("Jun 2026");
    expect(formatMonthHeading("2025-12")).toBe("Dec 2025");
  });

  it("formats day-cell and tooltip labels on the UTC day", () => {
    expect(formatMonthDayLabel("2026-06-01")).toBe("Jun 1");
    expect(formatMonthDayLabel("2026-06-30")).toBe("Jun 30");
    expect(formatMonthDayFull("2026-06-08")).toBe("Mon, Jun 8, 2026");
  });
});

describe("posting-calendar · intensity buckets", () => {
  it("bucket 0 is reserved for empty days", () => {
    expect(monthIntensityBucket(0, 10)).toBe(0);
  });

  it("a 1-post max day saturates (low-volume months stay readable)", () => {
    expect(monthIntensityBucket(1, 1)).toBe(MONTH_INTENSITY_STEPS - 1);
  });

  it("scales 1..5 against the month's busiest day", () => {
    expect(monthIntensityBucket(1, 10)).toBe(1);
    expect(monthIntensityBucket(4, 10)).toBe(2);
    expect(monthIntensityBucket(6, 10)).toBe(3);
    expect(monthIntensityBucket(8, 10)).toBe(4);
    expect(monthIntensityBucket(10, 10)).toBe(5);
  });
});
