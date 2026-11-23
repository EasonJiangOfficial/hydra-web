import { describe, expect, it } from "vitest";

import { dayKeyInZone } from "@/lib/ugc/days";

import { MAX_CUSTOM_DAYS, customRange, dayCount, parsePeriod, periodAt, periodInstants, periodLabel, periodParams, stepPeriod } from "./period";

const TO = "America/Toronto";
const H = 3_600_000;

describe("period ranges in the owner's zone", () => {
  it("a week starts on Monday, Sunday included", () => {
    expect(periodAt("weekly", "2026-11-21")).toEqual({ period: "weekly", from: "2026-11-16", to: "2026-11-22" });
    expect(periodAt("weekly", "2026-11-16")).toEqual({ period: "weekly", from: "2026-11-16", to: "2026-11-22" });
    expect(periodAt("weekly", "2026-11-22")).toEqual({ period: "weekly", from: "2026-11-16", to: "2026-11-22" });
    // Across a year end.
    expect(periodAt("weekly", "2027-01-01")).toEqual({ period: "weekly", from: "2026-12-28", to: "2027-01-03" });
  });

  it("months end on their last day, leap years included", () => {
    expect(periodAt("monthly", "2026-11-21")).toMatchObject({ from: "2026-11-01", to: "2026-11-30" });
    expect(periodAt("monthly", "2026-02-10")).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodAt("monthly", "2028-02-10")).toMatchObject({ from: "2028-02-01", to: "2028-02-29" });
    expect(periodAt("monthly", "2026-12-31")).toMatchObject({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("steps: day, week, month (from a 31st to February and back), custom by its own length", () => {
    expect(stepPeriod(periodAt("daily", "2026-02-28"), 1)).toMatchObject({ from: "2026-03-01", to: "2026-03-01" });
    expect(stepPeriod(periodAt("daily", "2026-01-01"), -1)).toMatchObject({ from: "2025-12-31" });
    expect(stepPeriod(periodAt("weekly", "2026-11-21"), 1)).toMatchObject({ from: "2026-11-23", to: "2026-11-29" });
    expect(stepPeriod(periodAt("weekly", "2026-11-21"), -3)).toMatchObject({ from: "2026-10-26", to: "2026-11-01" });
    const jan = periodAt("monthly", "2026-01-31");
    expect(stepPeriod(jan, 1)).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    expect(stepPeriod(jan, -1)).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
    expect(stepPeriod(stepPeriod(jan, 1), 1)).toMatchObject({ from: "2026-03-01", to: "2026-03-31" });
    expect(stepPeriod({ period: "custom", from: "2026-11-01", to: "2026-11-10" }, 1)).toEqual({
      period: "custom",
      from: "2026-11-11",
      to: "2026-11-20",
    });
  });

  it("instants follow the zone across DST: the fall-back week is 169 hours, the spring-forward day 23", () => {
    // DST ends Sunday, Nov 1, 2026 in Toronto.
    const fall = periodInstants(periodAt("weekly", "2026-10-28"), TO);
    expect(fall.start.toISOString()).toBe("2026-10-26T04:00:00.000Z");
    expect(fall.end.getTime() + 1 - fall.start.getTime()).toBe(169 * H);
    expect(dayKeyInZone(fall.end, TO)).toBe("2026-11-01");
    // DST starts Sunday, Mar 8, 2026.
    const spring = periodInstants(periodAt("daily", "2026-03-08"), TO);
    expect(spring.end.getTime() + 1 - spring.start.getTime()).toBe(23 * H);
    // November in Toronto: midnight EDT on the 1st, then EST to the end.
    const nov = periodInstants(periodAt("monthly", "2026-11-05"), TO);
    expect(nov.start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(nov.end.toISOString()).toBe("2026-12-01T04:59:59.999Z");
  });

  it("today is the owner's day: 10 PM Saturday in Toronto is still that week even though UTC says Sunday", () => {
    const now = new Date("2026-11-22T03:00:00.000Z");
    expect(periodAt("weekly", dayKeyInZone(now, TO))).toMatchObject({ from: "2026-11-16", to: "2026-11-22" });
    // A Sunday at 11 PM in Toronto is Monday in UTC; it still belongs to the week ending that Sunday.
    expect(periodAt("weekly", dayKeyInZone(new Date("2026-11-23T04:30:00.000Z"), TO))).toMatchObject({ from: "2026-11-16" });
    expect(periodAt("monthly", dayKeyInZone(new Date("2026-12-01T03:00:00.000Z"), TO))).toMatchObject({ from: "2026-11-01" });
  });

  it("parses the URL: default this month, fixed periods anchor on from, custom sorts and fills", () => {
    const today = "2026-11-21";
    expect(parsePeriod({}, today)).toEqual({ period: "monthly", from: "2026-11-01", to: "2026-11-30" });
    expect(parsePeriod({ period: "weekly", from: "2026-11-04" }, today)).toMatchObject({ from: "2026-11-02", to: "2026-11-08" });
    expect(parsePeriod({ period: "daily", from: "nope" }, today)).toMatchObject({ from: today, to: today });
    expect(parsePeriod({ period: "bogus", from: "2026-10-09" }, today)).toMatchObject({ period: "monthly", from: "2026-10-01" });
    expect(parsePeriod({ period: "custom", from: "2026-11-20", to: "2026-11-02" }, today)).toEqual({
      period: "custom",
      from: "2026-11-02",
      to: "2026-11-20",
    });
    expect(parsePeriod({ period: "custom", to: "2026-11-02" }, today)).toMatchObject({ from: "2026-11-02", to: "2026-11-02" });
    expect(periodParams(parsePeriod({}, today))).toEqual({ period: null, from: "2026-11-01", to: "2026-11-30" });
  });

  it("a custom range from a bad bookmark is bounded: at most a year, years 2000-2099 only", () => {
    const today = "2026-11-21";
    // Both days outside 2000-2099 are unreadable: the range is today alone, not 3.6M days.
    expect(parsePeriod({ period: "custom", from: "0001-01-01", to: "9999-12-31" }, today)).toEqual({ period: "custom", from: today, to: today });
    // Years 0-99 would become 1900-1999 in Date.UTC; they never parse.
    expect(parsePeriod({ period: "daily", from: "0050-03-01" }, today)).toMatchObject({ from: today });
    // A long range keeps its first day and is cut to MAX_CUSTOM_DAYS.
    const long = parsePeriod({ period: "custom", from: "2026-01-01", to: "2099-12-31" }, today);
    expect(long).toEqual({ period: "custom", from: "2026-01-01", to: "2027-01-01" });
    expect(dayCount(long)).toBe(MAX_CUSTOM_DAYS);
    expect(customRange("2030-05-05", "2026-01-01")).toEqual({ period: "custom", from: "2026-01-01", to: "2027-01-01" });
    expect(customRange("2026-11-07", "2026-11-01")).toEqual({ period: "custom", from: "2026-11-01", to: "2026-11-07" });
  });

  it("labels and day counts", () => {
    const today = "2026-11-21";
    expect(periodLabel(periodAt("monthly", today), today)).toBe("November 2026");
    expect(periodLabel(periodAt("weekly", today), today)).toBe("Nov 16 – 22");
    expect(periodLabel(periodAt("weekly", "2026-10-28"), today)).toBe("Oct 26 – Nov 1");
    expect(periodLabel(periodAt("weekly", "2027-01-01"), today)).toBe("Dec 28, 2026 – Jan 3, 2027");
    expect(periodLabel(periodAt("daily", today), today)).toBe("Sat, Nov 21");
    expect(periodLabel({ period: "custom", from: "2026-10-30", to: "2026-11-21" }, today)).toBe("Oct 30 – Nov 21");
    expect(dayCount(periodAt("weekly", "2026-10-28"))).toBe(7);
    expect(dayCount(periodAt("monthly", "2028-02-01"))).toBe(29);
  });
});
