import { describe, expect, it } from "vitest";
import {
  dueLabel,
  goalFigure,
  goalPace,
  longDate,
  monthlyCents,
  netWorthDelta,
  nextEstimatedTax,
  nextPayday,
  postingStreak,
  prevMonth,
  prevMonthSpan,
  signedPct,
  sliceNetWorth,
} from "./derive";
import type { NetWorthPoint } from "./types";

const pt = (day: string, netCents: number): NetWorthPoint => ({ day, netCents, assetsCents: netCents, debtsCents: 0 });

describe("net worth range", () => {
  const points = [pt("2026-01-05", 100), pt("2026-10-20", 200), pt("2026-11-14", 300), pt("2026-11-21", 400)];
  it("slices by range and always keeps the last point", () => {
    expect(sliceNetWorth(points, "1w", "2026-11-21").map((p) => p.day)).toEqual(["2026-11-14", "2026-11-21"]);
    expect(sliceNetWorth(points, "1m", "2026-11-21")).toHaveLength(2);
    expect(sliceNetWorth(points, "ytd", "2026-11-21")).toHaveLength(4);
    expect(sliceNetWorth(points, "all", "2026-11-21")).toHaveLength(4);
    expect(sliceNetWorth([pt("2026-01-05", 1)], "1w", "2026-11-21")).toHaveLength(1);
  });
  it("gives the change and its share", () => {
    expect(netWorthDelta(points)).toEqual({ cents: 300, pct: 300 });
    expect(netWorthDelta([pt("2026-11-01", 0), pt("2026-11-02", 5)]).pct).toBeNull();
    // The owner's live case: -$298.93 a month ago to $3,382.69 showed "1231.6%".
    expect(netWorthDelta([pt("2026-10-22", -29893), pt("2026-11-22", 338269)])).toEqual({ cents: 368162, pct: null });
    expect(netWorthDelta([])).toEqual({ cents: 0, pct: null });
  });
});

describe("due label", () => {
  it("counts days", () => {
    expect(dueLabel("2026-11-27", "2026-11-21")).toEqual({ text: "Due in 6 days", overdue: false });
    expect(dueLabel("2026-11-22", "2026-11-21").text).toBe("Due tomorrow");
    expect(dueLabel("2026-11-21", "2026-11-21").text).toBe("Due today");
    expect(dueLabel("2026-11-20", "2026-11-21")).toEqual({ text: "Overdue", overdue: true });
  });
});

describe("posting streak", () => {
  const day = (d: number, posted: number, target = 3) => ({
    date: `2026-11-${String(d).padStart(2, "0")}`,
    posted,
    target,
    future: d > 21,
  });
  it("counts hit days back from today and ignores a short today", () => {
    const days = [day(17, 3), day(18, 1), day(19, 3), day(20, 3), day(21, 1), day(22, 0)];
    expect(postingStreak(days, "2026-11-21")).toEqual({ streak: 2, reachedStart: false });
  });
  it("counts today once it is hit, skips days off, and reports the month start", () => {
    const days = [day(19, 3), day(20, 0, 0), day(21, 3)];
    expect(postingStreak(days, "2026-11-21")).toEqual({ streak: 2, reachedStart: true });
  });
});

describe("money helpers", () => {
  it("scales a charge to a month", () => {
    // The Accounts buckets: a 30-day bill is once a month, a weekly one 52/12 a month.
    expect(monthlyCents(-1000, 30)).toBe(1000);
    expect(monthlyCents(-1000, 31)).toBe(1000);
    expect(monthlyCents(5999, 7)).toBe(25_996);
    expect(monthlyCents(-2600, 14)).toBe(5633);
    expect(monthlyCents(-3000, 91)).toBe(1000);
    expect(monthlyCents(-6000, 182)).toBe(1000);
    expect(monthlyCents(-12000, 365)).toBe(1000);
    // An odd gap: 365 / 45 charges a year.
    expect(monthlyCents(-4500, 45)).toBe(3042);
  });
  it("formats the spending pill", () => {
    expect(signedPct(12.4)).toBe("+12%");
    expect(signedPct(-8.6)).toBe("-9%");
    expect(signedPct(0)).toBe("0%");
  });
  it("formats goal figures short", () => {
    expect(goalFigure("money", 3900)).toBe("$3.9k");
    expect(goalFigure("percent", 31)).toBe("31%");
    expect(goalFigure("count", 65)).toBe("65");
    expect(goalFigure("money", null)).toBe("-");
  });
  it("works out the pace a goal needs", () => {
    const base = { unit: "money", direction: "up", value: 3900, target: 10_000, deadline: "2026-12-31" } as const;
    expect(goalPace(base, "2026-11-21")).toBe("Needs $153 a day");
    expect(goalPace({ ...base, value: 10_000 }, "2026-11-21")).toBe("Target reached");
    expect(goalPace({ ...base, direction: "down" }, "2026-11-21")).toBeNull();
    expect(goalPace({ ...base, deadline: null }, "2026-11-21")).toBeNull();
  });
});

describe("dates", () => {
  it("finds the next pay day", () => {
    const none = { pay_cycle_anchor_day: null, pay_cycle_anchor_weekday: null, pay_cycle_anchor_days: [] };
    // 2026-11-21 is a Saturday (6); weekday 1 is the Monday after.
    expect(nextPayday({ ...none, pay_cycle: "WEEKLY", pay_cycle_anchor_weekday: 1 }, "2026-11-21")).toBe("2026-11-23");
    expect(nextPayday({ ...none, pay_cycle: "MONTHLY", pay_cycle_anchor_day: 5 }, "2026-11-21")).toBe("2026-12-05");
    expect(nextPayday({ ...none, pay_cycle: "MONTHLY", pay_cycle_anchor_day: 31 }, "2026-11-21")).toBe("2026-11-30");
    expect(nextPayday({ ...none, pay_cycle: "DAYS_OF_MONTH", pay_cycle_anchor_days: [1, 15] }, "2026-11-21")).toBe("2026-12-01");
    expect(nextPayday({ ...none, pay_cycle: "BIWEEKLY" }, "2026-11-21")).toBeNull();
  });
  it("finds the next estimated tax date", () => {
    expect(nextEstimatedTax("2026-11-21")).toEqual({ date: "2027-01-15", name: "Q4 2026 estimated tax" });
    expect(nextEstimatedTax("2026-01-15").date).toBe("2026-01-15");
  });
  it("finds last month's matching span", () => {
    expect(prevMonthSpan("2026-11-21")).toEqual({ from: "2026-10-01", to: "2026-10-21" });
    expect(prevMonthSpan("2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(prevMonthSpan("2026-01-05")).toEqual({ from: "2025-12-01", to: "2025-12-05" });
    expect(prevMonth("2026-01")).toBe("2025-12");
  });
  it("writes the long date", () => {
    expect(longDate("2026-11-21")).toBe("Saturday, November 21");
  });
});
