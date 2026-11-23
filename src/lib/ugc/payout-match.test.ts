import { describe, expect, it } from "vitest";

import { dayKeysBetween } from "@/lib/ugc/days";

import { owedCycles, payerKey, suggestPayoutMatches, type MatchDeal, type MatchPayment, type PayoutMatchInput } from "./payout-match";

const P = "00000000-0000-4000-8000-000000000101";
const T = "00000000-0000-4000-8000-000000000102";
const tx = (n: number) => `00000000-0000-4000-8000-${String(900 + n).padStart(12, "0")}`;

/** $10 a day from the start through `to`. */
function deal(id: string, brandName: string, over: Partial<MatchDeal> = {}, to = "2026-11-20"): MatchDeal {
  const startDate = over.startDate ?? "2026-09-01";
  const earned = new Map(dayKeysBetween(startDate, to).map((d) => [d, 1000]));
  return {
    id,
    brandName,
    startDate,
    endDate: null,
    status: "active",
    payCycle: "MONTHLY",
    anchorDay: 1,
    anchorWeekday: null,
    anchorDays: [],
    earnedByDay: earned,
    earnedCents: [...earned.values()].reduce((s, c) => s + c, 0),
    ...over,
  };
}

const base = (over: Partial<PayoutMatchInput>): PayoutMatchInput => ({
  today: "2026-11-21",
  deals: [deal(P, "Wordwise")],
  payments: [],
  deposits: [],
  rules: [],
  rejections: [],
  ...over,
});

const dep = (n: number, name: string, amountCents: number, postedOn: string) => ({ id: tx(n), name, amountCents, postedOn });
const paid = (n: number, dealId: string, name: string, amountCents: number, paidOn: string): MatchPayment => ({
  dealId,
  transactionId: tx(n),
  amountCents,
  paidOn,
  name,
});

describe("payerKey", () => {
  it("keeps the payer and drops numbers and noise", () => {
    expect(payerKey("PAYPAL TRANSFER 1001")).toBe("paypal transfer");
    expect(payerKey("PayPal Transfer 99-4421")).toBe("paypal transfer");
    expect(payerKey("WIRE FROM CHOICE FINANCIAL REF 7781")).toBe("wire choice financial");
    expect(payerKey("LaunchBoard Mercury ACH PPD")).toBe("launchboard mercury");
    expect(payerKey("Real Time Transfer RECD FROM ABA/021000021")).toBe("real time transfer");
    expect(payerKey("12345")).toBe("");
  });
});

describe("owedCycles", () => {
  it("cuts earnings at each pay day and pays the oldest cycle first", () => {
    const cycles = owedCycles(deal(P, "Wordwise"), 35_000, "2026-11-21");
    expect(cycles.map((c) => [c.closesOn, c.earnedCents, c.owedCents])).toEqual([
      ["2026-10-01", 30_000, 0],
      ["2026-11-01", 31_000, 26_000],
    ]);
  });

  it("without a pay cycle, all earnings are one cycle payable from the start", () => {
    const [c, ...rest] = owedCycles(deal(P, "Wordwise", { payCycle: null, anchorDay: null }), 0, "2026-11-21");
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ payableFrom: "2026-09-01", earnedCents: 81_000, owedCents: 81_000 });
  });

  it("an ended deal stops at the pay day after its end", () => {
    const cycles = owedCycles(deal(P, "Wordwise", { endDate: "2026-09-20", status: "ended" }, "2026-09-20"), 0, "2026-11-21");
    expect(cycles.map((c) => [c.closesOn, c.earnedCents])).toEqual([["2026-10-01", 20_000]]);
  });
});

describe("suggestPayoutMatches", () => {
  it("matches a deposit within 5% of a closed cycle, landed after it closed", () => {
    const r = suggestPayoutMatches(base({ deposits: [dep(1, "PAYPAL TRANSFER 1001", 29_200, "2026-10-03")] }));
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({ dealId: P, transactionId: tx(1), owedCents: 30_000 });
    expect(r.suggestions[0]!.reasons[0]).toBe("Owed $300 for the cycle that closed Oct 1");
  });

  it("a deposit before the cycle closed, or outside the tolerance, is not suggested", () => {
    const r = suggestPayoutMatches(
      base({ deposits: [dep(1, "PAYPAL TRANSFER", 30_000, "2026-09-28"), dep(2, "PAYPAL TRANSFER", 27_000, "2026-10-03")] }),
    );
    expect(r.suggestions).toEqual([]);
  });

  it("a backlog: one deposit for the sum of the oldest open cycles", () => {
    const r = suggestPayoutMatches(base({ deposits: [dep(1, "WIRE FROM CHOICE FINANCIAL", 61_000, "2026-11-03")] }));
    expect(r.suggestions[0]).toMatchObject({ owedCents: 61_000 });
    expect(r.suggestions[0]!.cycles.map((c) => c.closesOn)).toEqual(["2026-10-01", "2026-11-01"]);
  });

  it("matched deposits lower what is owed, so the next cycle is the one to match", () => {
    const r = suggestPayoutMatches(
      base({
        payments: [paid(9, P, "PAYPAL TRANSFER 1", 30_000, "2026-10-02")],
        deposits: [dep(1, "PAYPAL TRANSFER 2", 30_000, "2026-10-03"), dep(2, "PAYPAL TRANSFER 3", 31_000, "2026-11-02")],
      }),
    );
    expect(r.suggestions.map((s) => s.transactionId)).toEqual([tx(2)]);
  });

  it("a confirmed deposit pays the cycle it fits, not the oldest, so the older cycle still matches", () => {
    const cycles = owedCycles(deal(P, "Wordwise"), [{ amountCents: 31_000, paidOn: "2026-11-02" }], "2026-11-21");
    expect(cycles.map((c) => c.owedCents)).toEqual([30_000, 0]);
    const r = suggestPayoutMatches(
      base({
        payments: [paid(9, P, "PAYPAL TRANSFER 1", 31_000, "2026-11-02")],
        deposits: [dep(1, "PAYPAL TRANSFER 2", 29_250, "2026-10-03")],
      }),
    );
    expect(r.suggestions.map((s) => [s.transactionId, s.owedCents])).toEqual([[tx(1), 30_000]]);
  });

  it("one cycle takes one deposit; each deposit is suggested once", () => {
    const r = suggestPayoutMatches(
      base({ deposits: [dep(1, "ZELLE A", 30_000, "2026-10-05"), dep(2, "ZELLE B", 29_900, "2026-10-04")] }),
    );
    expect(r.suggestions.map((s) => s.transactionId)).toEqual([tx(1)]);
  });

  it("Not this removes the deposit from that deal for good", () => {
    const r = suggestPayoutMatches(
      base({ deposits: [dep(1, "PAYPAL TRANSFER", 30_000, "2026-10-03")], rejections: [{ dealId: P, transactionId: tx(1) }] }),
    );
    expect(r.suggestions).toEqual([]);
  });

  it("payer history decides between two deals owed the same amount", () => {
    const r = suggestPayoutMatches(
      base({
        deals: [deal(P, "Wordwise"), deal(T, "Brightleaf")],
        payments: [paid(8, T, "PAYPAL TRANSFER 77", 1, "2026-09-02")],
        deposits: [dep(1, "PAYPAL TRANSFER 1001", 30_000, "2026-10-03")],
      }),
    );
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({ dealId: T });
    expect(r.suggestions[0]!.reasons).toContain("Paypal Transfer paid Brightleaf 1 time before");
  });

  it("offers a rule after two confirmations from one payer, with the day they land near", () => {
    const payments = [paid(1, P, "PAYPAL TRANSFER 11", 30_000, "2026-10-01"), paid(2, P, "PAYPAL TRANSFER 12", 31_000, "2026-10-31")];
    const r = suggestPayoutMatches(base({ payments }));
    expect(r.ruleOffers).toEqual([
      expect.objectContaining({ dealId: P, payerKey: "paypal transfer", dayOfMonth: 1, confirmations: 2, text: "Paypal Transfer around the 1st is Wordwise" }),
    ]);
    // One confirmation is not enough; a decided rule is not offered again.
    expect(suggestPayoutMatches(base({ payments: payments.slice(0, 1) })).ruleOffers).toEqual([]);
    const declined = suggestPayoutMatches(
      base({ payments, rules: [{ dealId: P, payerKey: "paypal transfer", dayOfMonth: 1, dayWindow: 3, decision: "declined" }] }),
    );
    expect(declined.ruleOffers).toEqual([]);
  });

  it("deposits that land on scattered days give a rule with no day", () => {
    const payments = [paid(1, P, "ZELLE PAYMENT", 1, "2026-10-03"), paid(2, P, "ZELLE PAYMENT", 1, "2026-10-18")];
    expect(suggestPayoutMatches(base({ payments })).ruleOffers[0]).toMatchObject({ dayOfMonth: null, text: "Zelle Payment is Wordwise" });
  });

  it("an accepted rule suggests its payer's deposit near its day even when the amount does not fit", () => {
    const rules = [{ dealId: P, payerKey: "paypal transfer", dayOfMonth: 1, dayWindow: 3, decision: "accepted" as const }];
    const r = suggestPayoutMatches(
      base({
        rules,
        deposits: [dep(1, "PAYPAL TRANSFER 55", 12_345, "2026-10-30"), dep(2, "PAYPAL TRANSFER 56", 12_345, "2026-10-15")],
      }),
    );
    expect(r.suggestions.map((s) => [s.transactionId, s.owedCents])).toEqual([[tx(1), null]]);
    expect(r.suggestions[0]!.reasons).toContain("Paypal Transfer around the 1st is Wordwise");
  });

  it("a rule for one deal never takes another deal's exact amount fit (review 1)", () => {
    // Wordwise is paid up through Nov 1 and has a day-less PayPal rule; Brightleaf is owed $310 for the cycle that closed Nov 15.
    const wordwise = deal(P, "Wordwise", {}, "2026-10-31");
    const brightleaf = deal(T, "Brightleaf", { startDate: "2026-10-15", anchorDay: 15 }, "2026-11-14");
    const r = suggestPayoutMatches(
      base({
        deals: [wordwise, brightleaf],
        payments: [paid(1, P, "PAYPAL TRANSFER 1", 30_000, "2026-10-02"), paid(2, P, "PAYPAL TRANSFER 2", 31_000, "2026-11-02")],
        rules: [{ dealId: P, payerKey: "paypal transfer", dayOfMonth: null, dayWindow: 3, decision: "accepted" }],
        deposits: [dep(3, "PAYPAL TRANSFER 3", 31_000, "2026-11-16")],
      }),
    );
    expect(r.suggestions.map((s) => [s.dealId, s.owedCents])).toEqual([[T, 31_000]]);
  });

  it("a rule-only hit needs the deal to owe something", () => {
    const rules = [{ dealId: P, payerKey: "paypal transfer", dayOfMonth: null, dayWindow: 3, decision: "accepted" as const }];
    const r = suggestPayoutMatches(
      base({
        deals: [deal(P, "Wordwise", {}, "2026-10-31")],
        payments: [paid(1, P, "PAYPAL TRANSFER 1", 30_000, "2026-10-02"), paid(2, P, "PAYPAL TRANSFER 2", 31_000, "2026-11-02")],
        rules,
        deposits: [dep(3, "PAYPAL TRANSFER 3", 5_000, "2026-11-16")],
      }),
    );
    expect(r.suggestions).toEqual([]);
  });

  it("a payer confirmed for two deals gets no rule offer, and an old rule for it is not applied", () => {
    const payments = [
      paid(1, P, "PAYPAL TRANSFER 1", 30_000, "2026-10-01"),
      paid(2, P, "PAYPAL TRANSFER 2", 31_000, "2026-11-01"),
      paid(3, T, "PAYPAL TRANSFER 3", 1, "2026-09-10"),
    ];
    const deals = [deal(P, "Wordwise"), deal(T, "Brightleaf")];
    expect(suggestPayoutMatches(base({ deals, payments })).ruleOffers).toEqual([]);
    const rules = [{ dealId: P, payerKey: "paypal transfer", dayOfMonth: null, dayWindow: 3, decision: "accepted" as const }];
    const r = suggestPayoutMatches(base({ deals, payments, rules, deposits: [dep(4, "PAYPAL TRANSFER 4", 12_345, "2026-11-16")] }));
    expect(r.suggestions).toEqual([]);
  });

  it("a payout short by a fee closes its cycle, so a small unrelated deposit is not suggested (review 2)", () => {
    const cycles = owedCycles(deal(P, "Wordwise"), [{ amountCents: 29_250, paidOn: "2026-10-03" }], "2026-11-21");
    expect(cycles.map((c) => c.owedCents)).toEqual([0, 31_000]);
    const r = suggestPayoutMatches(
      base({
        payments: [paid(1, P, "PAYPAL TRANSFER 1", 29_250, "2026-10-03")],
        deposits: [dep(2, "INTEREST PAYMENT", 700, "2026-11-05")],
      }),
    );
    expect(r.suggestions).toEqual([]);
  });

  it("a pay cycle with no anchor is treated as no pay cycle (review 4)", () => {
    for (const over of [{ payCycle: "WEEKLY" as const, anchorDay: null }, { payCycle: "MONTHLY" as const, anchorDay: null }, { payCycle: "DAYS_OF_MONTH" as const }]) {
      const cycles = owedCycles(deal(P, "Wordwise", over), 0, "2026-11-21");
      expect(cycles).toHaveLength(1);
      expect(cycles[0]).toMatchObject({ closesOn: "2026-11-21", payableFrom: "2026-09-01", owedCents: 81_000 });
    }
    const r = suggestPayoutMatches(base({ deals: [deal(P, "Wordwise", { payCycle: "WEEKLY", anchorDay: null })], deposits: [dep(1, "WIRE", 81_000, "2026-11-20")] }));
    expect(r.suggestions).toHaveLength(1);
  });

  it("a rule near the 1st counts days in the real month (review 6)", () => {
    // Feb 27 is 2 days before Mar 1; a 31-day month count makes it 5.
    const rules = [{ dealId: P, payerKey: "paypal transfer", dayOfMonth: 1, dayWindow: 3, decision: "accepted" as const }];
    const r = suggestPayoutMatches({
      ...base({}),
      today: "2027-03-05",
      deals: [deal(P, "Wordwise", {}, "2027-03-04")],
      rules,
      deposits: [dep(1, "PAYPAL TRANSFER 9", 12_345, "2027-02-27")],
    });
    expect(r.suggestions.map((s) => s.transactionId)).toEqual([tx(1)]);
  });

  it("skips deposits before the deal started and deposits already matched", () => {
    const r = suggestPayoutMatches(
      base({
        deals: [deal(P, "Wordwise", { payCycle: null, anchorDay: null })],
        payments: [paid(1, P, "X", 100, "2026-10-01")],
        deposits: [dep(1, "PAYPAL", 80_900, "2026-10-01"), dep(2, "PAYPAL", 80_900, "2026-08-30")],
      }),
    );
    expect(r.suggestions).toEqual([]);
  });
});
