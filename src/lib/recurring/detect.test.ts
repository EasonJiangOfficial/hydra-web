import { describe, expect, it } from "vitest";
import { detectRecurring, nameKey, priceChangeFlagged, type RecurringRow } from "./detect";

let n = 0;
const r = (name: string, posted_on: string, amount_cents: number, over: Partial<RecurringRow> = {}): RecurringRow => ({
  id: `t${String(++n).padStart(3, "0")}`,
  name,
  posted_on,
  amount_cents,
  pending: false,
  is_transfer: false,
  hidden: false,
  ...over,
});

const monthly = (name: string, days: string[], amounts: number[]) => days.map((d, i) => r(name, d, amounts[i]));
const MONTHS = ["2026-06-15", "2026-07-15", "2026-08-15", "2026-09-15", "2026-10-15", "2026-11-15"];

describe("name key", () => {
  it.each([
    ["NETFLIX.COM 1234", "netflix com"],
    ["SQ *BLUE BOTTLE #12", "sq blue bottle"],
    ["  Spotify   USA ", "spotify usa"],
    ["Café 42", "café"],
    ["12345", ""],
  ])("%s -> %s", (name, key) => expect(nameKey(name)).toBe(key));
});

describe("recurring detection", () => {
  it("a fixed monthly charge with a price change: flagged while the new price is the newest row", () => {
    const rows = monthly("NETFLIX.COM", MONTHS, [-1549, -1549, -1549, -1549, -1549, -1799]);
    const [s] = detectRecurring(rows, "2026-11-20");
    expect(s).toEqual({
      name_key: "netflix com",
      name: "NETFLIX.COM",
      average_amount_cents: -1799,
      gap_days: 31,
      last_seen_on: "2026-11-15",
      next_expected_on: "2026-12-16",
      last_price_change: { from_cents: -1549, to_cents: -1799, on: "2026-11-15" },
      transaction_ids: rows.map((x) => x.id),
    });
    expect(priceChangeFlagged(s)).toBe(true);

    const next = detectRecurring([...rows, r("NETFLIX.COM", "2026-12-15", -1799)], "2026-12-20")[0];
    expect(next.last_price_change).toEqual({ from_cents: -1549, to_cents: -1799, on: "2026-11-15" });
    expect(priceChangeFlagged(next)).toBe(false);
  });

  it("a small price change is still a price change", () => {
    const [s] = detectRecurring(monthly("Spotify", MONTHS.slice(2), [-1099, -1099, -1099, -1199]), "2026-11-20");
    expect(s.last_price_change).toEqual({ from_cents: -1099, to_cents: -1199, on: "2026-11-15" });
  });

  it("a steady price has no price change", () => {
    const [s] = detectRecurring(monthly("Gym", MONTHS.slice(3), [-4000, -4000, -4000]), "2026-11-20");
    expect(s.average_amount_cents).toBe(-4000);
    expect(s.last_price_change).toBeNull();
  });

  it("a variable bill: steady within 20%, averaged, never a price change", () => {
    const [s] = detectRecurring(monthly("CITY POWER", MONTHS.slice(2), [-9000, -9400, -8800, -9600]), "2026-11-20");
    expect(s.average_amount_cents).toBe(-9200);
    expect(s.last_price_change).toBeNull();
  });

  it("weekly income is a series too", () => {
    const rows = ["2026-10-23", "2026-10-30", "2026-11-06", "2026-11-13", "2026-11-20"].map((d) => r("PAYROLL ACME", d, 120000));
    expect(detectRecurring(rows, "2026-11-21")[0]).toMatchObject({ gap_days: 7, average_amount_cents: 120000, next_expected_on: "2026-11-27" });
  });

  it("a refund does not break a charge series", () => {
    const rows = [...monthly("Spotify", MONTHS.slice(2), [-1199, -1199, -1199, -1199]), r("Spotify", "2026-10-20", 1199)];
    const [s] = detectRecurring(rows, "2026-11-20");
    expect(s.transaction_ids).toHaveLength(4);
    expect(s.last_price_change).toBeNull();
  });

  // [what, rows, today]
  const none: [string, () => RecurringRow[], string][] = [
    ["two rows are not enough", () => monthly("Hulu", MONTHS.slice(4), [-999, -999]), "2026-11-20"],
    ["an unsteady gap", () => monthly("AMZN", ["2026-08-01", "2026-08-03", "2026-09-20", "2026-11-15"], [-999, -999, -999, -999]), "2026-11-20"],
    ["wild amounts", () => monthly("Store", MONTHS.slice(3), [-1000, -5000, -9000]), "2026-11-20"],
    ["a one-off amount in the middle", () => monthly("App", MONTHS.slice(1), [-500, -500, -2000, -500, -500]), "2026-11-20"],
    ["an ended series (no row for two gaps)", () => monthly("Old gym", MONTHS.slice(0, 3), [-4000, -4000, -4000]), "2026-11-20"],
    ["same-day duplicates are not a gap", () => monthly("Bar", ["2026-11-01", "2026-11-01", "2026-11-01"], [-800, -800, -800]), "2026-11-20"],
    ["transfers do not count", () => MONTHS.map((d) => r("To savings", d, -50000, { is_transfer: true })), "2026-11-20"],
    ["pending rows do not count", () => MONTHS.map((d) => r("Pending", d, -100, { pending: true })), "2026-11-20"],
    ["hidden rows do not count", () => MONTHS.map((d) => r("Hidden", d, -100, { hidden: true })), "2026-11-20"],
  ];
  it.each(none)("nothing for %s", (_, make, today) => expect(detectRecurring(make(), today)).toEqual([]));

  it("separate names are separate series", () => {
    const rows = [...monthly("Netflix", MONTHS.slice(3), [-1549, -1549, -1549]), ...monthly("Hulu 0042", MONTHS.slice(3), [-999, -999, -999])];
    expect(detectRecurring(rows, "2026-11-20").map((s) => s.name_key).sort()).toEqual(["hulu", "netflix"]);
  });
});
