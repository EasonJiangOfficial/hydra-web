/**
 * Tests for lib/pay-cpm.ts — the single source of truth for CPM-component
 * math. These cases PIN the exact piecewise semantics documented in the
 * module docstring (segment boundaries, cap behaviour with/without tiers,
 * view units ≠ 1000, cents rounding, defensive input handling). This is
 * MONEY — any change to these numbers is a repricing event and must be
 * deliberate.
 */
import { describe, it, expect } from "vitest";
import {
  computeCpmPay,
  sanitizeCpmTiers,
  hasCpmComponent,
  type CpmSchedule,
} from "@/lib/ugc/pay-cpm";

/** Convenience: flat $2 per 1,000 views. */
function flat(over: Partial<CpmSchedule> = {}): CpmSchedule {
  return {
    ratePerUnit: 2,
    viewUnit: 1000,
    capViews: null,
    tiers: null,
    ...over,
  };
}

describe("computeCpmPay — flat rate", () => {
  it("pays rate × views / unit", () => {
    expect(computeCpmPay(50_000, flat()).toString()).toBe("100");
  });

  it("pays fractionally below one full unit (999 views @ $2/1k = $2.00 × 0.999)", () => {
    expect(computeCpmPay(999, flat()).toString()).toBe("2");
    // 999 × 2 / 1000 = 1.998 → rounds half-up to 2.00
  });

  it("zero views pays $0", () => {
    expect(computeCpmPay(0, flat()).toNumber()).toBe(0);
  });

  it("negative / non-finite views pay $0 (defensive)", () => {
    expect(computeCpmPay(-100, flat()).toNumber()).toBe(0);
    expect(computeCpmPay(Number.NaN, flat()).toNumber()).toBe(0);
  });

  it("no CPM component (null rate, no tiers) pays $0", () => {
    expect(
      computeCpmPay(1_000_000, flat({ ratePerUnit: null })).toNumber(),
    ).toBe(0);
  });

  it("explicit zero rate with no tiers pays $0 (explicitly disabled)", () => {
    expect(computeCpmPay(1_000_000, flat({ ratePerUnit: 0 })).toNumber()).toBe(
      0,
    );
  });
});

describe("computeCpmPay — view unit ≠ 1000", () => {
  it("per-100-views unit", () => {
    // $0.5 per 100 views × 10,000 views = $50
    expect(
      computeCpmPay(10_000, flat({ ratePerUnit: 0.5, viewUnit: 100 })).toString(),
    ).toBe("50");
  });

  it("per-single-view unit", () => {
    // $0.01 per view × 1,234 views = $12.34
    expect(
      computeCpmPay(1_234, flat({ ratePerUnit: 0.01, viewUnit: 1 })).toString(),
    ).toBe("12.34");
  });

  it("invalid view unit (0 / negative) falls back to 1000", () => {
    expect(computeCpmPay(50_000, flat({ viewUnit: 0 })).toString()).toBe("100");
    expect(computeCpmPay(50_000, flat({ viewUnit: -5 })).toString()).toBe(
      "100",
    );
  });
});

describe("computeCpmPay — cap (no tiers)", () => {
  const capped = flat({ capViews: 500_000 });

  it("below the cap pays in full", () => {
    expect(computeCpmPay(400_000, capped).toString()).toBe("800");
  });

  it("EXACTLY at the cap pays exactly cap/unit × rate", () => {
    expect(computeCpmPay(500_000, capped).toString()).toBe("1000");
  });

  it("above the cap pays nothing extra (hard stop)", () => {
    expect(computeCpmPay(750_000, capped).toString()).toBe("1000");
    expect(computeCpmPay(10_000_000, capped).toString()).toBe("1000");
  });

  it("one view above vs at the cap is identical", () => {
    expect(computeCpmPay(500_001, capped).toString()).toBe(
      computeCpmPay(500_000, capped).toString(),
    );
  });

  it("cap of 0 (or negative) means UNCAPPED", () => {
    expect(computeCpmPay(750_000, flat({ capViews: 0 })).toString()).toBe(
      "1500",
    );
    expect(computeCpmPay(750_000, flat({ capViews: -1 })).toString()).toBe(
      "1500",
    );
  });
});

describe("computeCpmPay — marginal tiers (the '$2 up to 500k then tiers' shape)", () => {
  // $2/1k up to 500k, then $1.50/1k to 1M, then $1/1k unbounded.
  const tiered = flat({
    capViews: 500_000,
    tiers: [
      { views: 500_000, ratePerUnit: 1.5 },
      { views: 1_000_000, ratePerUnit: 1 },
    ],
  });

  it("below the first threshold pays the base rate only", () => {
    expect(computeCpmPay(400_000, tiered).toString()).toBe("800");
  });

  it("EXACTLY at the threshold pays exactly the base segment", () => {
    expect(computeCpmPay(500_000, tiered).toString()).toBe("1000");
  });

  it("between tiers pays marginally (500k @ $2 + 250k @ $1.50)", () => {
    expect(computeCpmPay(750_000, tiered).toString()).toBe("1375");
  });

  it("EXACTLY at the second threshold", () => {
    // 500k×2 + 500k×1.5 = 1000 + 750 = 1750
    expect(computeCpmPay(1_000_000, tiered).toString()).toBe("1750");
  });

  it("above the last tier pays its rate unbounded", () => {
    // 1750 + 500k×$1/1k = 2250
    expect(computeCpmPay(1_500_000, tiered).toString()).toBe("2250");
  });

  it("tiers WITHOUT a cap: base rate runs to the first threshold", () => {
    const noCap = flat({
      tiers: [{ views: 500_000, ratePerUnit: 1.5 }],
    });
    expect(computeCpmPay(750_000, noCap).toString()).toBe("1375");
  });

  it("a gap between the cap and the first tier threshold pays NOTHING", () => {
    // Base rate stops at 100k; tier starts at 500k; [100k, 500k) is unpaid.
    const gappy = flat({
      capViews: 100_000,
      tiers: [{ views: 500_000, ratePerUnit: 1 }],
    });
    expect(computeCpmPay(300_000, gappy).toString()).toBe("200"); // 100k×$2/1k
    expect(computeCpmPay(600_000, gappy).toString()).toBe("300"); // +100k×$1/1k
  });

  it("tiers stored out of order are sorted before the piecewise walk", () => {
    const shuffled = flat({
      capViews: 500_000,
      tiers: [
        { views: 1_000_000, ratePerUnit: 1 },
        { views: 500_000, ratePerUnit: 1.5 },
      ],
    });
    expect(computeCpmPay(750_000, shuffled).toString()).toBe("1375");
  });

  it("tiers-only deal (no flat rate) pays only above the first threshold", () => {
    const tiersOnly = flat({
      ratePerUnit: null,
      tiers: [{ views: 100_000, ratePerUnit: 2 }],
    });
    expect(computeCpmPay(50_000, tiersOnly).toNumber()).toBe(0);
    expect(computeCpmPay(150_000, tiersOnly).toString()).toBe("100");
  });
});

describe("computeCpmPay — money precision (Decimal, no float drift)", () => {
  it("$2 CPM × 333,333 views = $666.67 (rounded to cents, half-up)", () => {
    // Float math gives 666.66600000000005-style drift; Decimal gives 666.666
    // exactly, rounded half-up to 666.67.
    expect(computeCpmPay(333_333, flat()).toString()).toBe("666.67");
  });

  it("$0.10 per 1k × 333 views rounds to 3 cents", () => {
    // 0.1 × 333 / 1000 = 0.0333 → $0.03
    expect(
      computeCpmPay(333, flat({ ratePerUnit: 0.1 })).toString(),
    ).toBe("0.03");
  });

  it("classic float-trap rate 0.1 + unit 1: 3 views = $0.30 exactly", () => {
    expect(
      computeCpmPay(3, flat({ ratePerUnit: 0.1, viewUnit: 1 })).toString(),
    ).toBe("0.3");
  });

  it("result is always a whole-cent Decimal (≤ 2dp)", () => {
    const r = computeCpmPay(777_777, flat({ ratePerUnit: 1.2345, viewUnit: 999 }));
    expect(r.decimalPlaces()).toBeLessThanOrEqual(2);
  });
});

describe("computeCpmPay — starting floor (minViews)", () => {
  // $2 per 1,000 views, CPM starts counting after 10,000 views.
  const floored = flat({ minViews: 10_000 });

  it("views BELOW the floor pay $0", () => {
    expect(computeCpmPay(8_000, floored).toNumber()).toBe(0);
  });

  it("views EXACTLY at the floor pay $0 (the floor is where counting STARTS)", () => {
    expect(computeCpmPay(10_000, floored).toNumber()).toBe(0);
  });

  it("views above the floor pay marginally from the floor", () => {
    // 15,000 views → only the 5,000 above the floor pay: 5k × $2/1k = $10.
    expect(computeCpmPay(15_000, floored).toString()).toBe("10");
    // 50,000 views → 40k × $2/1k = $80 (NOT the unfloored $100).
    expect(computeCpmPay(50_000, floored).toString()).toBe("80");
  });

  it("absent / null / zero / negative floor = today's counts-from-zero behavior", () => {
    expect(computeCpmPay(50_000, flat()).toString()).toBe("100");
    expect(computeCpmPay(50_000, flat({ minViews: null })).toString()).toBe("100");
    expect(computeCpmPay(50_000, flat({ minViews: 0 })).toString()).toBe("100");
    expect(computeCpmPay(50_000, flat({ minViews: -500 })).toString()).toBe("100");
    expect(computeCpmPay(50_000, flat({ minViews: Number.NaN })).toString()).toBe(
      "100",
    );
  });

  it("floor ABOVE the cap (no tiers) pays $0 — never negative", () => {
    const s = flat({ capViews: 500_000, minViews: 600_000 });
    expect(computeCpmPay(400_000, s).toNumber()).toBe(0);
    expect(computeCpmPay(600_000, s).toNumber()).toBe(0);
    expect(computeCpmPay(10_000_000, s).toNumber()).toBe(0);
  });

  it("floor inside a capped base segment clips it from below: [floor, cap)", () => {
    // $2/1k, cap 500k, floor 100k → 750k views pay (500k − 100k) × $2/1k.
    const s = flat({ capViews: 500_000, minViews: 100_000 });
    expect(computeCpmPay(750_000, s).toString()).toBe("800");
  });

  it("floor BETWEEN tiers: thresholds keep their absolute meaning", () => {
    // $2/1k to 500k, then $1.50/1k to 1M, then $1/1k — floor at 600k.
    const s = flat({
      capViews: 500_000,
      minViews: 600_000,
      tiers: [
        { views: 500_000, ratePerUnit: 1.5 },
        { views: 1_000_000, ratePerUnit: 1 },
      ],
    });
    // 750k views: base [0,500k) fully under the floor → $0; tier 1 pays only
    // [600k, 750k) = 150k × $1.50/1k = $225; tier 2 not reached.
    expect(computeCpmPay(750_000, s).toString()).toBe("225");
    // 1.2M views: tier 1 pays [600k, 1M) = 400k × $1.50/1k = $600;
    // tier 2 pays [1M, 1.2M) = 200k × $1/1k = $200. Total $800.
    expect(computeCpmPay(1_200_000, s).toString()).toBe("800");
    // Exactly at the floor still $0.
    expect(computeCpmPay(600_000, s).toNumber()).toBe(0);
  });

  it("floor below the first tier leaves tier money untouched", () => {
    // Floor 100k with tiers from 500k: base pays [100k, 500k), tiers as ever.
    const s = flat({
      capViews: 500_000,
      minViews: 100_000,
      tiers: [{ views: 500_000, ratePerUnit: 1.5 }],
    });
    // 750k: (500k−100k)×$2/1k + 250k×$1.50/1k = 800 + 375 = 1175.
    expect(computeCpmPay(750_000, s).toString()).toBe("1175");
  });

  it("Decimal precision at the floor boundary (no float drift, half-up cents)", () => {
    // $0.10 per 1k, floor 333: 666 views pay (666−333) × 0.1 / 1000 =
    // 0.0333 → $0.03 exactly (Decimal, half-up).
    expect(
      computeCpmPay(666, flat({ ratePerUnit: 0.1, minViews: 333 })).toString(),
    ).toBe("0.03");
    // Classic float trap: $0.1 per view, floor 3 → 6 views pay 3 × 0.1 = $0.30.
    expect(
      computeCpmPay(
        6,
        flat({ ratePerUnit: 0.1, viewUnit: 1, minViews: 3 }),
      ).toString(),
    ).toBe("0.3");
  });

  it("fractional floor is floored to an integer view count", () => {
    // floor 999.7 → 999: 1,999 views pay 1,000 × $2/1k = $2.
    expect(
      computeCpmPay(1_999, flat({ minViews: 999.7 })).toString(),
    ).toBe("2");
  });
});

describe("sanitizeCpmTiers / hasCpmComponent", () => {
  it("drops malformed tiers and sorts ascending", () => {
    expect(
      sanitizeCpmTiers([
        { views: 200, ratePerUnit: 1 },
        { views: 0, ratePerUnit: 5 }, // threshold must be > 0
        { views: 100, ratePerUnit: -1 } as never, // negative rate
        { views: Number.NaN, ratePerUnit: 1 } as never,
        { views: 100, ratePerUnit: 2 },
      ]),
    ).toEqual([
      { views: 100, ratePerUnit: 2 },
      { views: 200, ratePerUnit: 1 },
    ]);
  });

  it("non-array input → empty", () => {
    expect(sanitizeCpmTiers(null)).toEqual([]);
    expect(sanitizeCpmTiers(undefined)).toEqual([]);
  });

  it("hasCpmComponent: rate > 0 OR valid tiers", () => {
    expect(hasCpmComponent({ ratePerUnit: 2, tiers: null })).toBe(true);
    expect(
      hasCpmComponent({ ratePerUnit: null, tiers: [{ views: 1000, ratePerUnit: 1 }] }),
    ).toBe(true);
    expect(hasCpmComponent({ ratePerUnit: 0, tiers: [] })).toBe(false);
    expect(hasCpmComponent({ ratePerUnit: null, tiers: null })).toBe(false);
    // A tier list that sanitizes to nothing is NOT a component.
    expect(
      hasCpmComponent({ ratePerUnit: null, tiers: [{ views: 0, ratePerUnit: 9 }] }),
    ).toBe(false);
  });
});
