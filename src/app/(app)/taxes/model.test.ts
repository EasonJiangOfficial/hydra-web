import { describe, expect, test } from "vitest";
import {
  dueDate,
  missingW9,
  parseDollars,
  parseRate,
  rateText,
  setAsideCents,
  shortCents,
  timeline,
  yearChoices,
  type Payment,
  type TaxDoc,
} from "./model";

const pay = (quarter: 1 | 2 | 3 | 4, amountCents: number): Payment => ({ quarter, amountCents, paidOn: "2026-01-01" });

describe("dueDate", () => {
  test("2026 follows the IRS dates", () => {
    expect([1, 2, 3, 4].map((q) => dueDate(2026, q as 1 | 2 | 3 | 4))).toEqual(["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"]);
  });
  test("a weekend date moves to Monday", () => {
    expect(dueDate(2025, 2)).toBe("2025-06-16"); // Sunday
    expect(dueDate(2027, 2)).toBe("2027-06-15"); // Tuesday
    expect(dueDate(2028, 1)).toBe("2028-04-17"); // Saturday
  });
});

describe("set-aside", () => {
  test("net profit times rate, rounded to the cent", () => {
    expect(setAsideCents(3_891_482, 2500)).toBe(972_871); // 972,870.5 rounds up
    expect(setAsideCents(100_000, 0)).toBe(0);
  });
  test("a loss sets nothing aside", () => {
    expect(setAsideCents(-5_000, 2500)).toBe(0);
    expect(setAsideCents(0, 2500)).toBe(0);
  });
  test("short never goes below zero", () => {
    expect(shortCents(972_871, [pay(1, 210_000), pay(2, 290_000), pay(3, 340_000)])).toBe(132_871);
    expect(shortCents(100, [pay(1, 500)])).toBe(0);
  });
});

describe("parsing", () => {
  test("rates", () => {
    expect(parseRate("25")).toBe(2500);
    expect(parseRate(" 25% ")).toBe(2500);
    expect(parseRate("7.5")).toBe(750);
    expect(parseRate("100")).toBe(10_000);
    expect(parseRate("101")).toBeNull();
    expect(parseRate("-3")).toBeNull();
    expect(parseRate("abc")).toBeNull();
    expect(rateText(750)).toBe("7.5%");
    expect(rateText(2500)).toBe("25%");
  });
  test("dollars", () => {
    expect(parseDollars("1,328.71")).toBe(132_871);
    expect(parseDollars("$2100")).toBe(210_000);
    expect(parseDollars("5.5")).toBe(550);
    expect(parseDollars("0")).toBeNull();
    expect(parseDollars("1.234")).toBeNull();
    expect(parseDollars("")).toBeNull();
  });
});

describe("timeline", () => {
  test("paid quarters keep their payment; the rest split what is short", () => {
    const t = timeline(2026, "2026-11-21", [pay(1, 210_000), pay(2, 290_000), pay(3, 340_000)], 972_871);
    expect(t.map((q) => q.status)).toEqual(["paid", "paid", "paid", "due-soon"]);
    expect(t[3].daysLeft).toBe(55);
    expect(t[3].suggestedCents).toBe(132_871);
  });
  test("the split adds up and the first open quarter takes the extra cent", () => {
    const t = timeline(2026, "2026-01-02", [], 100_001);
    expect(t.map((q) => q.suggestedCents)).toEqual([25_001, 25_000, 25_000, 25_000]);
    expect(t.map((q) => q.status)).toEqual(["upcoming", "upcoming", "upcoming", "upcoming"]);
  });
  test("an unpaid past quarter is overdue", () => {
    const t = timeline(2026, "2026-07-01", [], 400_000);
    expect(t.map((q) => q.status)).toEqual(["overdue", "overdue", "upcoming", "upcoming"]);
  });
  test("nothing short means nothing suggested", () => {
    const t = timeline(2026, "2026-02-01", [pay(1, 500)], 100);
    expect(t.every((q) => q.suggestedCents === 0)).toBe(true);
  });
});

describe("documents", () => {
  const doc = (payer: string | null, kind: TaxDoc["kind"] = "w9"): TaxDoc => ({ id: payer ?? "x", kind, name: "f.pdf", payer, sizeBytes: 1, addedOn: "2026-01-01" });
  test("a payer with no W-9 under their name is missing, ignoring case and spaces", () => {
    const payers = [{ name: "Wordwise" }, { name: "Brightleaf" }, { name: "Canvasly" }];
    expect(missingW9(payers, [doc(" wordwise "), doc("Brightleaf", "1099")])).toEqual(["Brightleaf", "Canvasly"]);
  });
});

test("the year switch offers this year and two before", () => {
  expect(yearChoices("2026-11-21")).toEqual([2024, 2025, 2026]);
});
