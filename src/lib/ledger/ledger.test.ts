import { describe, expect, it } from "vitest";
import { findTransferPairs, type PairCandidate } from "./pairing";
import { flowTotals, type CategoryKind, type FlowRow } from "./totals";

const CHECKING = "acc-checking";
const SAVINGS = "acc-savings";
const CARD = "acc-card";

let n = 0;
function row(account_id: string, amount_cents: number, posted_on: string, over: Partial<PairCandidate> = {}): PairCandidate {
  n += 1;
  return {
    id: `t${String(n).padStart(3, "0")}`,
    account_id,
    amount_cents,
    posted_on,
    pending: false,
    transfer_pair_id: null,
    category_source: "none",
    ...over,
  };
}

describe("transfer and card-payment pairing", () => {
  // [what, rows, expected pairs as [outflow index, inflow index]]
  const cases: [string, () => PairCandidate[], [number, number][]][] = [
    ["checking to savings, same day", () => [row(CHECKING, -50000, "2026-11-02"), row(SAVINGS, 50000, "2026-11-02")], [[0, 1]]],
    ["card payment: checking out, card in, two days later", () => [row(CHECKING, -41000, "2026-11-03"), row(CARD, 41000, "2026-11-05")], [[0, 1]]],
    ["the inflow may post first", () => [row(CHECKING, -100, "2026-11-05"), row(SAVINGS, 100, "2026-11-01")], [[0, 1]]],
    ["outside the 5-day window", () => [row(CHECKING, -100, "2026-11-01"), row(SAVINGS, 100, "2026-11-07")], []],
    ["same account is not a transfer", () => [row(CHECKING, -100, "2026-11-01"), row(CHECKING, 100, "2026-11-01")], []],
    ["amounts must be equal", () => [row(CHECKING, -100, "2026-11-01"), row(SAVINGS, 101, "2026-11-01")], []],
    ["same sign is not a pair", () => [row(CHECKING, -100, "2026-11-01"), row(SAVINGS, -100, "2026-11-01")], []],
    ["pending rows wait", () => [row(CHECKING, -100, "2026-11-01", { pending: true }), row(SAVINGS, 100, "2026-11-01")], []],
    ["a row already paired is left alone", () => [row(CHECKING, -100, "2026-11-01"), row(SAVINGS, 100, "2026-11-01", { transfer_pair_id: "x" })], []],
    ["a row edited by hand is left alone", () => [row(CHECKING, -100, "2026-11-01", { category_source: "manual" }), row(SAVINGS, 100, "2026-11-01")], []],
    [
      "the closest date wins, each row pairs once",
      () => [
        row(CHECKING, -100, "2026-11-10"),
        row(SAVINGS, 100, "2026-11-07"),
        row(CARD, 100, "2026-11-10"),
        row(CHECKING, -100, "2026-11-12"),
      ],
      [
        [0, 2],
        [3, 1],
      ],
    ],
    [
      "equal gaps: the earlier row, then the lower id",
      () => [row(CHECKING, -100, "2026-11-10"), row(CARD, 100, "2026-11-12"), row(SAVINGS, 100, "2026-11-08")],
      [[0, 2]],
    ],
    ["across a month end", () => [row(CHECKING, -7500, "2026-10-30"), row(CARD, 7500, "2026-11-02")], [[0, 1]]],
  ];

  it.each(cases)("%s", (_, make, expected) => {
    const rows = make();
    expect(findTransferPairs(rows)).toEqual(expected.map(([a, b]) => ({ a: rows[a].id, b: rows[b].id })));
  });

  it("the window is a setting", () => {
    const rows = [row(CHECKING, -100, "2026-11-01"), row(SAVINGS, 100, "2026-11-09")];
    expect(findTransferPairs(rows, 7)).toEqual([]);
    expect(findTransferPairs(rows, 8)).toEqual([{ a: rows[0].id, b: rows[1].id }]);
  });
});

describe("income and spending", () => {
  const kinds = new Map<string, CategoryKind>([
    ["shopping", "expense"],
    ["dining", "expense"],
    ["paycheck", "income"],
    ["transfers", "transfer"],
  ]);
  const r = (amount_cents: number, category_id: string | null, over: Partial<FlowRow> = {}): FlowRow => ({
    amount_cents,
    category_id,
    is_transfer: false,
    hidden: false,
    ...over,
  });

  // [what, rows, income, spending]
  const cases: [string, FlowRow[], number, number][] = [
    ["a purchase is spending", [r(-5000, "shopping")], 0, 5000],
    ["a refund reduces its category", [r(-5000, "shopping"), r(2000, "shopping")], 0, 3000],
    ["a refund is never income", [r(2000, "shopping")], 0, -2000],
    ["a paycheck is income", [r(250000, "paycheck")], 250000, 0],
    ["a reversal reduces income", [r(250000, "paycheck"), r(-10000, "paycheck")], 240000, 0],
    ["a paired transfer is neither", [r(-50000, "shopping", { is_transfer: true }), r(50000, null, { is_transfer: true })], 0, 0],
    ["a transfer category is neither", [r(-41000, "transfers")], 0, 0],
    ["hidden rows are neither", [r(-900, "dining", { hidden: true })], 0, 0],
    ["uncategorized counts by sign", [r(-700, null), r(1200, null)], 1200, 700],
  ];

  it.each(cases)("%s", (_, rows, income, spending) => {
    const t = flowTotals(rows, kinds);
    expect(t.incomeCents).toBe(income);
    expect(t.spendingCents).toBe(spending);
  });

  it("totals per category, refunds netted in", () => {
    const t = flowTotals([r(-5000, "shopping"), r(2000, "shopping"), r(-1500, "dining"), r(-300, null), r(800, null)], kinds);
    expect(t.categories).toEqual([
      { categoryId: "shopping", kind: "expense", cents: 3000 },
      { categoryId: "dining", kind: "expense", cents: 1500 },
      { categoryId: null, kind: "expense", cents: 300 },
      { categoryId: null, kind: "income", cents: 800 },
    ]);
  });
});
