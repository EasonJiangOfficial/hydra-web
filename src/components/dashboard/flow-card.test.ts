import { describe, expect, it } from "vitest";
import { fitFor } from "./dashboard";
import { FIXTURE_BUSINESS, fixtureData } from "./fixture";
import { topCategories, wholeDollars } from "./flow-card";

describe("income and expenses legend", () => {
  it("rounds rows so they add up to the rounded Expenses figure", () => {
    // $1.60 x 3 rounds to $2 each ($6), but Expenses is $4.80 -> $5.
    expect(wholeDollars([160, 160, 160], 480)).toEqual([2, 2, 1]);
    // Studio Co: the categories and the -$30 Refunds row add up to $1,180.
    const studio = fixtureData(FIXTURE_BUSINESS);
    const cents = [...topCategories(studio.categories).map((s) => s.cents), -studio.refundCents];
    expect(wholeDollars(cents, studio.month.spendingCents).reduce((a, d) => a + d, 0)).toBe(1180);
    expect(wholeDollars([1_049, 2_051, -1_000], 2_100)).toEqual([10, 21, -10]);
  });

  it("gives each slice its own gray, dark to light by size, Other last", () => {
    const rows = topCategories(fixtureData("all").categories);
    expect(rows.map((r) => r.name)).toEqual(["Housing", "Food", "Software", "Transport", "Shopping", "Other"]);
    expect(new Set(rows.map((r) => r.fill)).size).toBe(6);
    expect(rows.map((r) => r.fill)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `var(--slice-${n})`));
  });
});

describe("fitFor", () => {
  it("never shows $0 Cash and Cards with no accounts: a UGC scope keeps its UGC tile alone", () => {
    const ugc = { ...fixtureData("ugc"), hasAccounts: false };
    expect(fitFor(ugc)("summary", "phone")).toEqual({ h: 1 });
    expect(fitFor(fixtureData(FIXTURE_BUSINESS))("summary", "phone")).toBe(false);
    expect(fitFor(fixtureData("ugc"))("summary", "phone")).toBeUndefined();
  });

  it("grows the phone income block with its legend rows, so the chart keeps its 160 px", () => {
    const studio = fitFor(fixtureData(FIXTURE_BUSINESS))("income-expenses", "phone");
    const personal = fitFor(fixtureData("personal"))("income-expenses", "phone");
    // Studio Co: 6 slices + Refunds = 7 rows; Personal: 5 rows. A block of h rows is 68h - 12 px.
    expect(studio).toEqual({ h: 10 });
    expect(personal && 68 * personal.h! - 12).toBeGreaterThanOrEqual(274 + 164 + 32 * 5);
    expect(personal).toEqual({ h: 9 });
  });

  it("fits Recent and Coming up to their rows on the phone", () => {
    const all = fitFor(fixtureData("all"));
    expect(all("recent", "phone")).toEqual({ h: 4, even: true, list: true });
    expect(all("coming-up", "phone")).toEqual({ h: 3, even: true, list: true });
  });

  it("fits each list to its own rows; an empty list keeps its one-line height and never evens up", () => {
    const fit = fitFor(fixtureData(FIXTURE_BUSINESS));
    // Studio Co: 3 goals, 1 thing coming up. Each fits itself; fitItems evens them when they share a row.
    expect(fit("goals", "desktop")).toEqual({ h: 4, even: true, list: true });
    expect(fit("coming-up", "desktop")).toEqual({ h: 3, even: true, list: true });
    const none = fitFor(fixtureData("ugm"));
    expect(none("goals", "desktop")).toEqual({ h: 3, list: true });
    expect(none("goals", "phone")).toEqual({ h: 2, list: true });
  });

  it("Recent keeps its row height beside UGC and Posting on the desktop, and fits its list elsewhere", () => {
    const eight = { ...fixtureData("all"), recent: Array.from({ length: 8 }, (_, i) => fixtureData("all").recent[i % fixtureData("all").recent.length]) };
    expect(fitFor(eight)("recent", "desktop")).toBeUndefined();
    expect(fitFor({ ...eight, ugc: null })("recent", "desktop")).toMatchObject({ list: true });
    expect(fitFor(eight)("recent", "phone")).toMatchObject({ even: true, list: true });
  });
});
