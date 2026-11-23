import { describe, expect, it } from "vitest";

import { financeDatesBetween, payDays, taxDates, type DealFact } from "./finance-dates";

const deal = (over: Partial<DealFact> = {}): DealFact => ({
  id: "d1",
  brand: "Wordwise",
  status: "active",
  startDate: "2026-09-01",
  endDate: null,
  payCycle: "MONTHLY",
  anchorDay: 28,
  anchorWeekday: null,
  anchorDays: [],
  owedCents: 120_000,
  ...over,
});

describe("tax dates", () => {
  it("lists the four estimated dates, the fourth in January of the next year", () => {
    expect(taxDates("2026-02-01", "2027-01-31").map((d) => [d.date, d.label])).toEqual([
      ["2026-04-15", "Q1 estimated tax and tax return"],
      ["2026-06-15", "Q2 estimated tax"],
      ["2026-09-15", "Q3 estimated tax"],
      ["2027-01-15", "Q4 estimated tax"],
    ]);
  });
  it("a weekend date moves to Monday", () => {
    expect(taxDates("2025-06-01", "2025-06-30").map((d) => d.date)).toEqual(["2025-06-16"]); // Jun 15, 2025 is a Sunday
    expect(taxDates("2025-09-01", "2025-09-30").map((d) => d.date)).toEqual(["2025-09-15"]);
  });
  it("January picks up the previous year's Q4", () => {
    expect(taxDates("2027-01-01", "2027-01-31").map((d) => d.label)).toEqual(["Q4 estimated tax"]);
  });
});

describe("pay days", () => {
  it("monthly clamps to a short month", () => {
    expect(payDays(deal({ anchorDay: 31 }), "2026-11-01", "2026-12-31")).toEqual(["2026-11-30", "2026-12-31"]);
  });
  it("weekly is every matching weekday; no weekday means none", () => {
    expect(payDays(deal({ payCycle: "WEEKLY", anchorWeekday: 5 }), "2026-11-01", "2026-11-30")).toEqual([
      "2026-11-06",
      "2026-11-13",
      "2026-11-20",
      "2026-11-27",
    ]);
    expect(payDays(deal({ payCycle: "WEEKLY", anchorWeekday: null }), "2026-11-01", "2026-11-30")).toEqual([]);
  });
  it("biweekly counts from the first matching weekday after the start", () => {
    // Sep 1, 2026 is a Tuesday; the first Friday is Sep 4, then every 14 days (Nov 13, Nov 27).
    const d = deal({ payCycle: "BIWEEKLY", anchorWeekday: 5 });
    expect(payDays(d, "2026-11-01", "2026-11-30")).toEqual(["2026-11-13", "2026-11-27"]);
  });
  it("days of month takes each listed day", () => {
    expect(payDays(deal({ payCycle: "DAYS_OF_MONTH", anchorDays: [1, 15] }), "2026-11-01", "2026-11-30")).toEqual(["2026-11-01", "2026-11-15"]);
  });
  it("stays inside the deal's own dates", () => {
    expect(payDays(deal({ endDate: "2026-11-20" }), "2026-11-01", "2026-12-31")).toEqual([]);
    expect(payDays(deal({ startDate: "2026-11-29" }), "2026-11-01", "2026-12-31")).toEqual(["2026-12-28"]);
  });
});

describe("finance dates", () => {
  const facts = {
    cards: [
      { id: "c1", name: "Sapphire 4242", dueOn: "2026-11-25", balanceCents: 84_212 },
      { id: "c2", name: "No due date", dueOn: null, balanceCents: 0 },
    ],
    deals: [deal(), deal({ id: "d2", brand: "Paused", status: "paused" })],
  };

  it("shows the card due date, the payout and tax dates, soonest first", () => {
    const got = financeDatesBetween(facts, "2026-11-01", "2026-11-30", "2026-11-21");
    expect(got.map((d) => [d.date, d.kind, d.label, d.amountCents])).toEqual([
      ["2026-11-25", "card", "Sapphire 4242 due", 84_212],
      ["2026-11-28", "payout", "Wordwise payout", 120_000],
    ]);
  });
  it("puts the owed amount on the next payout only", () => {
    const got = financeDatesBetween(facts, "2026-11-01", "2027-02-28", "2026-11-21").filter((d) => d.kind === "payout");
    expect(got.map((d) => d.amountCents)).toEqual([120_000, null, null, null]);
    // A later month still knows which payout is next.
    const dec = financeDatesBetween(facts, "2026-12-01", "2026-12-31", "2026-11-21").filter((d) => d.kind === "payout");
    expect(dec.map((d) => d.amountCents)).toEqual([null]);
  });
  it("shows no payout for a day that has passed", () => {
    expect(financeDatesBetween(facts, "2026-11-01", "2026-11-30", "2026-11-29").filter((d) => d.kind === "payout")).toEqual([]);
  });
  it("shows the January tax date", () => {
    expect(financeDatesBetween(facts, "2027-01-01", "2027-01-31", "2026-11-21").map((d) => d.label)).toContain("Q4 estimated tax");
  });
});
