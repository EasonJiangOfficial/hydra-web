import { describe, expect, it } from "vitest";
import {
  ago,
  centsToDollars,
  dollarsToCents,
  everyLabel,
  initials,
  itemHealth,
  parseIdleMinutes,
  perMonthCents,
  perYearCents,
  shortDate,
  usedPercent,
} from "./format";
import type { AccountWithBalance } from "./types";

describe("dollarsToCents", () => {
  it.each([
    ["1234.50", 123450],
    ["$1,234.5", 123450],
    ["-12.34", -1234],
    ["0.07", 7],
    [".5", 50],
    ["12", 1200],
    ["0.10", 10],
    ["19.99", 1999],
    ["-0", 0],
  ])("%s", (text, cents) => expect(dollarsToCents(text)).toBe(cents));
  it.each(["", "abc", "1.234", "1,2,x", "--5", "$", "."])("rejects %j", (text) => expect(dollarsToCents(text)).toBeNull());
  it("round trips", () => expect(dollarsToCents(centsToDollars(-5))).toBe(-5));
});

describe("labels", () => {
  it("short date", () => expect(shortDate("2026-11-27")).toBe("Nov 27"));
  it("every", () => {
    expect([7, 14, 30, 31, 91, 182, 365, 10].map(everyLabel)).toEqual(["Week", "2 weeks", "Month", "Month", "3 months", "6 months", "Year", "10 days"]);
  });
  it("ago", () => {
    const now = "2026-11-21T15:00:00Z";
    expect(ago("2026-11-21T14:59:30Z", now)).toBe("just now");
    expect(ago("2026-11-21T14:40:00Z", now)).toBe("20 min ago");
    expect(ago("2026-11-21T13:00:00Z", now)).toBe("2 h ago");
    expect(ago("2026-11-18T15:00:00Z", now)).toBe("3 d ago");
  });
  it("initials", () => {
    expect([initials("Chase Checking"), initials("Car"), initials("  ")]).toEqual(["CC", "CA", ""]);
  });
});

describe("recurring maths", () => {
  it("a monthly charge is twelve a year, whether its gap is 30 or 31 days", () => {
    expect(perYearCents(-5999, 30)).toBe(-71_988);
    expect(perYearCents(-5999, 31)).toBe(-71_988);
    expect(perMonthCents(-5999, 30)).toBe(-5999);
    expect(perYearCents(-145_000, 30)).toBe(-1_740_000); // rent $1,450: $17,400 a year
  });
  it("a 6-month charge is two a year", () => expect(perYearCents(-59_400, 182)).toBe(-118_800));
  it("weekly, every 2 weeks, quarterly and yearly use their buckets; an odd gap uses 365 / gap", () => {
    expect(perYearCents(-1000, 7)).toBe(-52_000);
    expect(perYearCents(-1000, 14)).toBe(-26_000);
    expect(perYearCents(-1000, 91)).toBe(-4000);
    expect(perYearCents(-1000, 366)).toBe(-1000);
    expect(perYearCents(-1000, 50)).toBe(-7300);
  });
});

describe("health and use of limit", () => {
  it("maps item status", () => {
    expect(itemHealth(undefined)).toBe("manual");
    expect(itemHealth({ status: "active" })).toBe("healthy");
    expect(itemHealth({ status: "login_required" })).toBe("reconnect");
    expect(itemHealth({ status: "pending_expiration" })).toBe("reconnect");
    expect(itemHealth({ status: "error" })).toBe("error");
    expect(itemHealth({ status: "revoked" })).toBe("revoked");
  });
  it("use of limit", () => {
    const card = (owed: number | null, limit: number | null) => ({ balance: { current_cents: owed, limit_cents: limit } }) as AccountWithBalance;
    expect(usedPercent(card(160_410, 1_000_000))).toBe(16);
    expect(usedPercent(card(2_000_000, 1_000_000))).toBe(100);
    expect(usedPercent(card(5, null))).toBeNull();
    expect(usedPercent(card(null, 100))).toBeNull();
  });
});

describe("idle lock minutes", () => {
  it.each([
    ["", null],
    ["  ", null],
    ["1", 1],
    ["60", 60],
    ["15", 15],
    ["0", "invalid"],
    ["61", "invalid"],
    ["5.5", "invalid"],
    ["-3", "invalid"],
    ["abc", "invalid"],
  ])("%j", (text, expected) => expect(parseIdleMinutes(text)).toBe(expected));
});
