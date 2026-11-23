/**
 * Tests for lib/pay-aggregate.ts — the SHARED canonical pay model used by both
 * lib/pay-cycle-service.ts and app/api/brand/creators/[id]/videos. Locks in the
 * aggregate-bonus contract so the two callers can never diverge (Codex #221).
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  resolveRowRate,
  computeAggregatePay,
  type AggregateVideoInput,
  type FallbackRate,
  type ResolvedRate,
} from "@/lib/ugc/pay-aggregate";

/** No-CPM defaults so the pre-CPM cases keep their exact numbers. */
const noCpm: Pick<
  ResolvedRate,
  "cpmRatePerUnit" | "cpmViewUnit" | "cpmCapViews" | "cpmTiers" | "cpmMode" | "cpmMinViews" | "tierEvaluationMode"
> = {
  cpmRatePerUnit: null,
  cpmViewUnit: 1000,
  cpmCapViews: null,
  cpmTiers: [],
  cpmMode: "ADD",
  cpmMinViews: null,
  tierEvaluationMode: "PER_VIDEO",
};

const fallback: FallbackRate = {
  paymentPerVideo: 25,
  basePayMinViews: 1000,
  viewBonuses: [{ views: 100000, bonus: 100 }],
  viewBonusMode: "REPLACE",
  ...noCpm,
};

const rate: ResolvedRate = {
  paymentPerVideo: 25,
  basePayMinViews: 1000,
  viewBonuses: [{ views: 100000, bonus: 100 }],
  viewBonusMode: "REPLACE",
  ...noCpm,
};

/** No-snapshot defaults for the new cpm snapshot columns. */
const noCpmSnapshot = {
  cpmRateSnapshot: null,
  cpmViewUnitSnapshot: 1000,
  cpmCapViewsSnapshot: null,
  cpmTiersSnapshot: null,
  cpmModeSnapshot: "ADD",
  cpmMinViewsSnapshot: null,
  tierEvaluationModeSnapshot: "PER_VIDEO",
} as const;

function video(over: Partial<AggregateVideoInput> = {}): AggregateVideoInput {
  return {
    bestViews: 0,
    rate,
    override: null,
    excluded: false,
    postedAt: new Date("2026-05-01T00:00:00Z"),
    dealKey: "d0",
    ...over,
  };
}

describe("resolveRowRate", () => {
  it("uses the campaign fallback when the row has no snapshot", () => {
    const r = resolveRowRate(
      {
        paymentPerVideoSnapshot: null,
        basePayMinViewsSnapshot: 0,
        viewBonusesSnapshot: null,
        viewBonusModeSnapshot: "REPLACE",
        ...noCpmSnapshot,
      },
      fallback,
    );
    expect(r.paymentPerVideo).toBe(25);
    expect(r.basePayMinViews).toBe(1000);
  });

  it("uses the row snapshot when present", () => {
    const r = resolveRowRate(
      {
        paymentPerVideoSnapshot: new Decimal(40),
        basePayMinViewsSnapshot: 2000,
        viewBonusesSnapshot: [{ views: 50000, bonus: 70 }] as unknown as unknown,
        viewBonusModeSnapshot: "STACK",
        ...noCpmSnapshot,
      },
      fallback,
    );
    expect(r.paymentPerVideo).toBe(40);
    expect(r.basePayMinViews).toBe(2000);
    expect(r.viewBonusMode).toBe("STACK");
  });

  it("falls back when the row is undefined (no linked PlatformPost)", () => {
    const r = resolveRowRate(undefined, fallback);
    expect(r.paymentPerVideo).toBe(25);
  });

  it("a CPM-ONLY snapshot counts as a snapshot (no fallback to current rate)", () => {
    // A post synced under a CPM-only deal has null base pay + null bonuses.
    // It must NOT silently reprice at the campaign's CURRENT rate.
    const r = resolveRowRate(
      {
        paymentPerVideoSnapshot: null,
        basePayMinViewsSnapshot: 0,
        viewBonusesSnapshot: null,
        viewBonusModeSnapshot: "REPLACE",
        cpmRateSnapshot: new Decimal(2),
        cpmViewUnitSnapshot: 1000,
        cpmCapViewsSnapshot: 500_000,
        cpmTiersSnapshot: null,
        cpmModeSnapshot: "ADD",
        cpmMinViewsSnapshot: null,
        tierEvaluationModeSnapshot: "PER_VIDEO",
      },
      fallback,
    );
    expect(r.paymentPerVideo).toBe(0); // snapshot's null base, NOT fallback's 25
    expect(r.cpmRatePerUnit).toBe(2);
    expect(r.cpmCapViews).toBe(500_000);
    expect(r.viewBonuses).toEqual([]);
  });

  it("a CPM-TIERS-only snapshot also counts as a snapshot", () => {
    const r = resolveRowRate(
      {
        paymentPerVideoSnapshot: null,
        basePayMinViewsSnapshot: 0,
        viewBonusesSnapshot: null,
        viewBonusModeSnapshot: "REPLACE",
        cpmRateSnapshot: null,
        cpmViewUnitSnapshot: 1000,
        cpmCapViewsSnapshot: null,
        cpmTiersSnapshot: [
          { views: 100000, ratePerUnit: 1.5 },
        ] as unknown as unknown,
        cpmModeSnapshot: "ADD",
        cpmMinViewsSnapshot: null,
        tierEvaluationModeSnapshot: "PER_VIDEO",
      },
      fallback,
    );
    expect(r.paymentPerVideo).toBe(0);
    expect(r.cpmTiers).toEqual([{ views: 100000, ratePerUnit: 1.5 }]);
  });

  it("an EXPLICIT EMPTY viewBonusesSnapshot ([]) IS a snapshot — disabled bonuses never resurrect from live rates", () => {
    // A post synced while bonuses were DISABLED (e.g. a per-creator override
    // set viewBonuses = []) snapshots an explicit empty array. That row must
    // keep its empty bonus table — not fall back to the campaign's CURRENT
    // bonuses (Codex HIGH, PR #280: presence derives from raw nullness).
    const r = resolveRowRate(
      {
        paymentPerVideoSnapshot: null,
        basePayMinViewsSnapshot: 0,
        viewBonusesSnapshot: [] as unknown as unknown,
        viewBonusModeSnapshot: "REPLACE",
        ...noCpmSnapshot,
      },
      fallback,
    );
    expect(r.paymentPerVideo).toBe(0); // snapshot's null base, NOT fallback's 25
    expect(r.viewBonuses).toEqual([]); // NOT fallback's tier table
    const agg = computeAggregatePay([video({ bestViews: 200_000, rate: r })]);
    expect(agg.bonusPay.toNumber()).toBe(0);
    expect(agg.totalPay.toNumber()).toBe(0);
  });

  it("an EXPLICIT EMPTY cpmTiersSnapshot ([]) IS a snapshot — disabled tiers never resurrect from live rates", () => {
    const r = resolveRowRate(
      {
        paymentPerVideoSnapshot: null,
        basePayMinViewsSnapshot: 0,
        viewBonusesSnapshot: null,
        viewBonusModeSnapshot: "REPLACE",
        cpmRateSnapshot: null,
        cpmViewUnitSnapshot: 1000,
        cpmCapViewsSnapshot: null,
        cpmTiersSnapshot: [] as unknown as unknown,
        cpmModeSnapshot: "ADD",
        cpmMinViewsSnapshot: null,
        tierEvaluationModeSnapshot: "PER_VIDEO",
      },
      fallback,
    );
    expect(r.paymentPerVideo).toBe(0);
    expect(r.cpmRatePerUnit).toBeNull();
    expect(r.cpmTiers).toEqual([]);
  });

  it("undefined snapshot columns (narrow select / pre-CPM row shape) still mean NO snapshot", () => {
    // A row shape minted before the CPM columns existed reads them as
    // undefined — that must mean "no snapshot", so the fallback applies.
    const r = resolveRowRate(
      {
        paymentPerVideoSnapshot: null,
        basePayMinViewsSnapshot: 0,
        viewBonusesSnapshot: null,
        viewBonusModeSnapshot: "REPLACE",
      } as unknown as Parameters<typeof resolveRowRate>[0],
      fallback,
    );
    expect(r.paymentPerVideo).toBe(25); // falls back to the campaign rate
    expect(r.viewBonuses).toEqual([{ views: 100000, bonus: 100 }]);
  });

  it("an UNDEFINED paymentPerVideoSnapshot column (narrow select) is NOT a $0-base snapshot — fallback applies", () => {
    // Adversarial review finding 3, PR #280: only the CPM columns were
    // `?? null`-normalized. A row shape whose select omits the BASE-PAY
    // snapshot column reads it as undefined; `undefined !== null` made it
    // register as "has a snapshot" and the row silently paid $0 base
    // (toNum(undefined) → 0) instead of falling back to the campaign rate.
    const r = resolveRowRate(
      {
        // paymentPerVideoSnapshot deliberately MISSING (undefined).
        basePayMinViewsSnapshot: 0,
        viewBonusesSnapshot: null,
        viewBonusModeSnapshot: "REPLACE",
        ...noCpmSnapshot,
      } as unknown as Parameters<typeof resolveRowRate>[0],
      fallback,
    );
    expect(r.paymentPerVideo).toBe(25); // falls back — NOT a silent $0
    expect(r.basePayMinViews).toBe(1000);
    expect(r.viewBonuses).toEqual([{ views: 100000, bonus: 100 }]);
    const agg = computeAggregatePay([video({ bestViews: 10_000, rate: r })]);
    expect(agg.totalPay.toNumber()).toBe(25);
  });

  it("SNAPSHOT IMMUTABILITY: a later campaign rate/CPM change never moves a snapshotted row", () => {
    const snapshotRow = {
      paymentPerVideoSnapshot: new Decimal(25),
      basePayMinViewsSnapshot: 1000,
      viewBonusesSnapshot: [
        { views: 100000, bonus: 100 },
      ] as unknown as unknown,
      viewBonusModeSnapshot: "REPLACE",
      cpmRateSnapshot: new Decimal(2),
      cpmViewUnitSnapshot: 1000,
      cpmCapViewsSnapshot: 500_000,
      cpmTiersSnapshot: null,
      cpmModeSnapshot: "ADD",
      cpmMinViewsSnapshot: null,
      tierEvaluationModeSnapshot: "PER_VIDEO",
    };
    // The campaign was then edited to a wildly different deal:
    const editedCampaign: FallbackRate = {
      paymentPerVideo: 999,
      basePayMinViews: 0,
      viewBonuses: [{ views: 1, bonus: 9999 }],
      viewBonusMode: "ADD",
      cpmRatePerUnit: 50,
      cpmViewUnit: 10,
      cpmCapViews: null,
      cpmTiers: [{ views: 1, ratePerUnit: 99 }],
      cpmMode: "REPLACE",
      cpmMinViews: 5,
      tierEvaluationMode: "PER_VIDEO",
    };
    const r = resolveRowRate(snapshotRow, editedCampaign);
    expect(r.paymentPerVideo).toBe(25);
    expect(r.cpmRatePerUnit).toBe(2);
    expect(r.cpmViewUnit).toBe(1000);
    expect(r.cpmCapViews).toBe(500_000);
    expect(r.cpmTiers).toEqual([]);
    // And the resulting pay is identical before/after the campaign edit.
    const agg = computeAggregatePay([video({ bestViews: 10_000, rate: r })]);
    expect(agg.totalPay.toNumber()).toBe(25 + 20); // base 25 + 10k×$2/1k CPM
  });
});

describe("computeAggregatePay — aggregate bonus, never per-video", () => {
  it("applies ONE bonus tier even when several videos clear it (REPLACE)", () => {
    const agg = computeAggregatePay([
      video({ bestViews: 120000 }),
      video({ bestViews: 150000 }),
    ]);
    expect(agg.totalViews).toBe(270000);
    // ONE $100 bonus, not two.
    expect(agg.bonusPay.toNumber()).toBe(100);
    // REPLACE: max(baseSum=50, bonus=100) = 100.
    expect(agg.totalPay.toNumber()).toBe(100);
  });

  it("reaches a tier only on summed views (under-pay fix)", () => {
    const agg = computeAggregatePay([
      video({ bestViews: 60000 }),
      video({ bestViews: 60000 }),
    ]);
    expect(agg.totalViews).toBe(120000);
    expect(agg.bonusPay.toNumber()).toBe(100);
    expect(agg.totalPay.toNumber()).toBe(100);
  });

  it("STACK mode adds the single aggregate bonus to summed base pay", () => {
    const stackRate: ResolvedRate = { ...rate, viewBonusMode: "STACK" };
    const agg = computeAggregatePay([
      video({ bestViews: 120000, rate: stackRate }),
      video({ bestViews: 150000, rate: stackRate }),
    ]);
    // base 50 + ONE bonus 100 = 150.
    expect(agg.totalPay.toNumber()).toBe(150);
    expect(agg.basePay.toNumber()).toBe(50);
  });

  it("excludes a flagged video from pay AND from the bonus aggregate", () => {
    const agg = computeAggregatePay([
      video({ bestViews: 60000 }),
      video({ bestViews: 60000, excluded: true }),
    ]);
    expect(agg.videoCount).toBe(1);
    expect(agg.totalViews).toBe(60000);
    expect(agg.bonusPay.toNumber()).toBe(0);
    expect(agg.totalPay.toNumber()).toBe(25);
  });

  it("override wins for its video but its views still feed the aggregate", () => {
    const agg = computeAggregatePay([
      video({ bestViews: 60000, override: new Decimal(40) }),
      video({ bestViews: 60000 }),
    ]);
    expect(agg.totalViews).toBe(120000);
    expect(agg.bonusPay.toNumber()).toBe(100);
    // basePay reported = base(25) + override(40) = 65.
    expect(agg.basePay.toNumber()).toBe(65);
    // REPLACE: max(baseSum=25, bonus=100)=100, + overrideSum(40) = 140.
    expect(agg.totalPay.toNumber()).toBe(140);
  });

  it("gates per-video base pay on each video's own min-views threshold", () => {
    const agg = computeAggregatePay([
      video({ bestViews: 500 }), // under 1000 → no base
      video({ bestViews: 5000 }), // clears → +25
    ]);
    expect(agg.qualifiedVideoCount).toBe(1);
    expect(agg.basePay.toNumber()).toBe(25);
  });

  it("picks the bonus-tier table from the chronologically-latest video", () => {
    const oldRate: ResolvedRate = {
      ...rate,
      viewBonuses: [{ views: 100000, bonus: 999 }],
    };
    const newRate: ResolvedRate = {
      ...rate,
      viewBonuses: [{ views: 100000, bonus: 100 }],
    };
    const agg = computeAggregatePay([
      video({
        bestViews: 60000,
        rate: oldRate,
        postedAt: new Date("2026-05-01T00:00:00Z"),
      }),
      video({
        bestViews: 60000,
        rate: newRate,
        postedAt: new Date("2026-05-10T00:00:00Z"),
      }),
    ]);
    // The later deal's tier table ($100) wins deterministically.
    expect(agg.bonusPay.toNumber()).toBe(100);
  });
});

/**
 * The brand-side "match / unmatch a video TO the campaign" toggle drives the
 * `excluded` input here (matched → excluded:false, unmatched → excluded:true).
 * These cases prove the payout RECOMPUTE honors that toggle exactly: an
 * unmatched video leaves the total AND the bonus aggregate; re-matching restores
 * both; the toggle is per-video; it dedups by UnifiedVideo group (the caller
 * collapses a group to one input); and it interacts correctly with overrides.
 */
describe("computeAggregatePay — match/unmatch toggle drives the recompute", () => {
  it("unmatching a video removes it from the total AND the bonus tier", () => {
    // Two 60k videos together clear the 100k bonus tier → $100 (REPLACE).
    const bothMatched = computeAggregatePay([
      video({ bestViews: 60000 }),
      video({ bestViews: 60000 }),
    ]);
    expect(bothMatched.totalViews).toBe(120000);
    expect(bothMatched.bonusPay.toNumber()).toBe(100);
    expect(bothMatched.totalPay.toNumber()).toBe(100);

    // Unmatch one (excluded:true). Now only 60k views → tier NOT reached, and
    // the unmatched video pays $0. Total drops to a single base pay ($25).
    const oneUnmatched = computeAggregatePay([
      video({ bestViews: 60000 }),
      video({ bestViews: 60000, excluded: true }),
    ]);
    expect(oneUnmatched.videoCount).toBe(1);
    expect(oneUnmatched.totalViews).toBe(60000);
    expect(oneUnmatched.bonusPay.toNumber()).toBe(0);
    expect(oneUnmatched.totalPay.toNumber()).toBe(25);
  });

  it("re-matching a previously-unmatched video restores its pay + bonus", () => {
    const unmatched = computeAggregatePay([
      video({ bestViews: 60000 }),
      video({ bestViews: 60000, excluded: true }),
    ]);
    expect(unmatched.totalPay.toNumber()).toBe(25);

    // Flip the toggle back on (matched → excluded:false): full state returns.
    const reMatched = computeAggregatePay([
      video({ bestViews: 60000 }),
      video({ bestViews: 60000, excluded: false }),
    ]);
    expect(reMatched.videoCount).toBe(2);
    expect(reMatched.totalViews).toBe(120000);
    expect(reMatched.bonusPay.toNumber()).toBe(100);
    expect(reMatched.totalPay.toNumber()).toBe(100);
  });

  it("unmatching is per-video — other videos keep counting", () => {
    const agg = computeAggregatePay([
      video({ bestViews: 5000 }), // matched → +25
      video({ bestViews: 5000, excluded: true }), // unmatched → $0
      video({ bestViews: 5000 }), // matched → +25
    ]);
    expect(agg.videoCount).toBe(2);
    expect(agg.qualifiedVideoCount).toBe(2);
    expect(agg.totalPay.toNumber()).toBe(50);
  });

  it("a cross-platform video unmatched once is dropped ONCE (UnifiedVideo dedup)", () => {
    // The caller (pay-cycle-service / videos route) collapses a UnifiedVideo
    // group's IG+TikTok rows into ONE input and marks it excluded when ANY row
    // is flagged. So unmatching the group contributes a single excluded input —
    // never double-counted, never half-paid.
    const matched = computeAggregatePay([video({ bestViews: 80000 })]);
    expect(matched.totalPay.toNumber()).toBe(25);

    const unmatched = computeAggregatePay([
      video({ bestViews: 80000, excluded: true }),
    ]);
    expect(unmatched.videoCount).toBe(0);
    expect(unmatched.totalViews).toBe(0);
    expect(unmatched.totalPay.toNumber()).toBe(0);
  });

  it("unmatching an override video removes BOTH its override and its views", () => {
    // Matched: override(40) rides on base; its 60k views feed the aggregate with
    // the other 60k to reach the 100k tier → REPLACE max(25,100)+40 = 140.
    const matched = computeAggregatePay([
      video({ bestViews: 60000, override: new Decimal(40) }),
      video({ bestViews: 60000 }),
    ]);
    expect(matched.totalPay.toNumber()).toBe(140);

    // Unmatch the override video: its override AND its views leave. Now only the
    // plain 60k video remains → no tier, just its $25 base. The manual override
    // does NOT survive an unmatch.
    const unmatched = computeAggregatePay([
      video({ bestViews: 60000, override: new Decimal(40), excluded: true }),
      video({ bestViews: 60000 }),
    ]);
    expect(unmatched.overrideSum.toNumber()).toBe(0);
    expect(unmatched.totalViews).toBe(60000);
    expect(unmatched.totalPay.toNumber()).toBe(25);
  });
});

// ─── CPM component — full composition matrix (mix-and-match) ────────────────
//
// A deal may hold ANY subset of {base pay, CPM, view bonuses}. These cases pin
// every combination plus the REPLACE/ADD interaction rule: REPLACE replaces
// BASE PAY ONLY — a bonus never erases CPM earnings.

/** $2 per 1,000 views, no cap, no tiers. */
const flatCpm = {
  cpmRatePerUnit: 2,
  cpmViewUnit: 1000,
  cpmCapViews: null,
  cpmTiers: [] as { views: number; ratePerUnit: number }[],
};

function rateOf(over: Partial<ResolvedRate>): ResolvedRate {
  return { ...rate, ...over };
}

describe("computeAggregatePay — CPM composition matrix", () => {
  const NO_BASE = { paymentPerVideo: 0, basePayMinViews: 0 };
  const NO_BONUS = { viewBonuses: [] as { views: number; bonus: number }[] };

  it("base ONLY (no CPM, no bonuses)", () => {
    const r = rateOf({ ...NO_BONUS });
    const agg = computeAggregatePay([video({ bestViews: 50_000, rate: r })]);
    expect(agg.basePay.toNumber()).toBe(25);
    expect(agg.cpmPay.toNumber()).toBe(0);
    expect(agg.bonusPay.toNumber()).toBe(0);
    expect(agg.totalPay.toNumber()).toBe(25);
  });

  it("CPM ONLY (no base, no bonuses)", () => {
    const r = rateOf({ ...NO_BASE, ...NO_BONUS, ...flatCpm });
    const agg = computeAggregatePay([video({ bestViews: 50_000, rate: r })]);
    expect(agg.basePay.toNumber()).toBe(0);
    expect(agg.cpmPay.toNumber()).toBe(100); // 50k × $2/1k
    expect(agg.totalPay.toNumber()).toBe(100);
  });

  it("bonuses ONLY (no base, no CPM)", () => {
    const r = rateOf({ ...NO_BASE });
    const agg = computeAggregatePay([video({ bestViews: 120_000, rate: r })]);
    expect(agg.basePay.toNumber()).toBe(0);
    expect(agg.bonusPay.toNumber()).toBe(100);
    expect(agg.totalPay.toNumber()).toBe(100);
  });

  it("base + CPM (no bonuses)", () => {
    const r = rateOf({ ...NO_BONUS, ...flatCpm });
    const agg = computeAggregatePay([video({ bestViews: 50_000, rate: r })]);
    expect(agg.totalPay.toNumber()).toBe(25 + 100);
  });

  it("base + bonuses (no CPM) — pre-existing semantics unchanged", () => {
    const agg = computeAggregatePay([video({ bestViews: 120_000 })]);
    expect(agg.totalPay.toNumber()).toBe(100); // REPLACE max(25, 100)
  });

  it("CPM + bonuses (no base)", () => {
    const r = rateOf({ ...NO_BASE, ...flatCpm });
    const agg = computeAggregatePay([video({ bestViews: 120_000, rate: r })]);
    // REPLACE: max(base=0, bonus=100)=100, + CPM 240 = 340.
    expect(agg.cpmPay.toNumber()).toBe(240);
    expect(agg.bonusPay.toNumber()).toBe(100);
    expect(agg.totalPay.toNumber()).toBe(340);
  });

  it("ALL THREE: base + CPM + bonuses (REPLACE)", () => {
    const r = rateOf({ ...flatCpm });
    const agg = computeAggregatePay([video({ bestViews: 120_000, rate: r })]);
    // REPLACE replaces BASE only: max(25, 100)=100, then CPM rides on top.
    expect(agg.totalPay.toNumber()).toBe(100 + 240);
  });

  it("ALL THREE: base + CPM + bonuses (ADD)", () => {
    const r = rateOf({ ...flatCpm, viewBonusMode: "ADD" });
    const agg = computeAggregatePay([video({ bestViews: 120_000, rate: r })]);
    expect(agg.totalPay.toNumber()).toBe(25 + 100 + 240);
  });

  it("REPLACE never erases CPM even when the bonus beats base + CPM combined", () => {
    // base $5, CPM $10, bonus $1000 — REPLACE compares ONLY base vs bonus.
    const r = rateOf({
      paymentPerVideo: 5,
      basePayMinViews: 0,
      viewBonuses: [{ views: 1000, bonus: 1000 }],
      cpmRatePerUnit: 2,
      cpmViewUnit: 1000,
      cpmCapViews: null,
      cpmTiers: [],
    });
    const agg = computeAggregatePay([video({ bestViews: 5_000, rate: r })]);
    // max(5, 1000) + cpm(10) = 1010 — NOT max(5+10, 1000) = 1000.
    expect(agg.totalPay.toNumber()).toBe(1010);
  });

  it("CPM is NOT gated by the base-pay min-views threshold", () => {
    const r = rateOf({ ...NO_BONUS, ...flatCpm, basePayMinViews: 100_000 });
    const agg = computeAggregatePay([video({ bestViews: 50_000, rate: r })]);
    expect(agg.basePay.toNumber()).toBe(0); // gate not cleared
    expect(agg.cpmPay.toNumber()).toBe(100); // CPM still pays
    expect(agg.totalPay.toNumber()).toBe(100);
  });

  it("a manually-overridden video earns NO CPM (override IS its pay)", () => {
    const r = rateOf({ ...NO_BONUS, ...flatCpm });
    const agg = computeAggregatePay([
      video({ bestViews: 50_000, rate: r, override: new Decimal(40) }),
    ]);
    expect(agg.cpmPay.toNumber()).toBe(0);
    expect(agg.totalPay.toNumber()).toBe(40);
  });

  it("an excluded video earns NO CPM", () => {
    const r = rateOf({ ...NO_BONUS, ...flatCpm });
    const agg = computeAggregatePay([
      video({ bestViews: 50_000, rate: r, excluded: true }),
    ]);
    expect(agg.cpmPay.toNumber()).toBe(0);
    expect(agg.totalPay.toNumber()).toBe(0);
  });

  it("CPM is PER-VIDEO: each video runs its own snapshot schedule on its own views", () => {
    const capped = rateOf({
      ...NO_BASE,
      ...NO_BONUS,
      ...flatCpm,
      cpmCapViews: 100_000,
    });
    const uncapped = rateOf({ ...NO_BASE, ...NO_BONUS, ...flatCpm });
    const agg = computeAggregatePay([
      video({ bestViews: 150_000, rate: capped }), // capped at 100k → $200
      video({ bestViews: 150_000, rate: uncapped }), // full 150k → $300
    ]);
    expect(agg.cpmPay.toNumber()).toBe(500);
    expect(agg.totalPay.toNumber()).toBe(500);
  });

  it("Decimal precision: $2 CPM × 333,333 views = $666.67 exactly (no float drift)", () => {
    const r = rateOf({ ...NO_BASE, ...NO_BONUS, ...flatCpm });
    const agg = computeAggregatePay([video({ bestViews: 333_333, rate: r })]);
    expect(agg.cpmPay.toString()).toBe("666.67");
    expect(agg.totalPay.toString()).toBe("666.67");
  });

  it("pay-cycle shape: mixed components across videos sum into one entry", () => {
    // Creator with: one base-only video, one CPM-only video, one all-three
    // video — plus an excluded one. Mirrors a real mid-migration campaign.
    const baseOnly = rateOf({ ...NO_BONUS });
    const cpmOnly = rateOf({ ...NO_BASE, ...NO_BONUS, ...flatCpm });
    const allThree = rateOf({ ...flatCpm, viewBonusMode: "ADD" });
    const agg = computeAggregatePay([
      video({ bestViews: 10_000, rate: baseOnly }), // base 25
      video({ bestViews: 20_000, rate: cpmOnly }), // cpm 40
      video({
        bestViews: 120_000,
        rate: allThree,
        postedAt: new Date("2026-06-01T00:00:00Z"), // latest deal → ADD table
      }),
      video({ bestViews: 999_999, rate: cpmOnly, excluded: true }), // $0
    ]);
    // bases: 25 + 25 (all-three video clears 1000 min) = 50
    expect(agg.basePaySum.toNumber()).toBe(50);
    // cpm: 40 + 240 = 280
    expect(agg.cpmPay.toNumber()).toBe(280);
    // ONE aggregate bonus on 150k views (latest deal = ADD, table 100k→$100)
    expect(agg.bonusPay.toNumber()).toBe(100);
    expect(agg.totalPay.toNumber()).toBe(50 + 280 + 100);
  });
});

// ─── cpmMode: ADD vs REPLACE composition + cpmMinViews floor ────────────────
//
// cpmMode ADD (default) is byte-identical to the pre-mode behavior (every
// case above runs with cpmMode "ADD"). cpmMode REPLACE pays the BETTER of
// the bonus lane (REPLACE: max(baseSum, bonus) | STACK: baseSum + bonus) or
// the CPM lane: totalPay = max(bonusLane, cpmSum) + overrideSum. All
// fixtures hand-computed.

describe("computeAggregatePay — cpmMode REPLACE composition", () => {
  const NO_BONUS = { viewBonuses: [] as { views: number; bonus: number }[] };

  it("REPLACE bonus mode + CPM lane WINS: total = cpmSum (+ nothing else)", () => {
    // 2 videos, $25 base each (baseSum 50); bonus table 100k → $100 matched
    // on 270k summed views; bonusLane = max(50, 100) = 100.
    // CPM $2/1k per video: 240 + 300 = 540. REPLACE: max(100, 540) = 540.
    const r = rateOf({ ...flatCpm, cpmMode: "REPLACE" });
    const agg = computeAggregatePay([
      video({ bestViews: 120_000, rate: r }),
      video({ bestViews: 150_000, rate: r }),
    ]);
    expect(agg.cpmMode).toBe("REPLACE");
    expect(agg.cpmPay.toNumber()).toBe(540);
    expect(agg.bonusPay.toNumber()).toBe(100);
    expect(agg.totalPay.toNumber()).toBe(540);
  });

  it("REPLACE bonus mode + bonus lane WINS: total = bonusLane (CPM subsumed)", () => {
    // Same shape but a tiny CPM rate ($0.10/1k): cpm = 12 + 15 = 27.
    // bonusLane = max(50, 100) = 100 > 27 → total 100.
    const r = rateOf({ ...flatCpm, cpmRatePerUnit: 0.1, cpmMode: "REPLACE" });
    const agg = computeAggregatePay([
      video({ bestViews: 120_000, rate: r }),
      video({ bestViews: 150_000, rate: r }),
    ]);
    expect(agg.cpmPay.toNumber()).toBe(27);
    expect(agg.totalPay.toNumber()).toBe(100);
  });

  it("STACK bonus mode + cpmMode REPLACE: lane = baseSum + bonus, then max()", () => {
    const r = rateOf({
      ...flatCpm,
      viewBonusMode: "STACK",
      cpmMode: "REPLACE",
    });
    // bonusLane = 50 + 100 = 150; cpm = 540 → total 540 (cpm wins).
    const cpmWins = computeAggregatePay([
      video({ bestViews: 120_000, rate: r }),
      video({ bestViews: 150_000, rate: r }),
    ]);
    expect(cpmWins.totalPay.toNumber()).toBe(540);
    // Tiny CPM: lane 150 vs cpm 27 → 150.
    const tiny = rateOf({ ...r, cpmRatePerUnit: 0.1 });
    const laneWins = computeAggregatePay([
      video({ bestViews: 120_000, rate: tiny }),
      video({ bestViews: 150_000, rate: tiny }),
    ]);
    expect(laneWins.totalPay.toNumber()).toBe(150);
  });

  it("overrides ride ON TOP of the max() in REPLACE mode", () => {
    const r = rateOf({ ...flatCpm, cpmMode: "REPLACE" });
    const agg = computeAggregatePay([
      video({ bestViews: 120_000, rate: r }),
      video({ bestViews: 150_000, rate: r }),
      video({ bestViews: 60_000, rate: r, override: new Decimal(30) }),
    ]);
    // Overridden video: no base, no CPM — but its 60k views still aggregate
    // (totalViews 330k; the 100k tier was already matched).
    // max(bonusLane=100, cpmSum=540) + override 30 = 570.
    expect(agg.overrideSum.toNumber()).toBe(30);
    expect(agg.totalPay.toNumber()).toBe(570);
  });

  it("zero-CPM campaign with cpmMode REPLACE = existing behavior exactly", () => {
    // No CPM configured → cpmSum 0 → max(bonusLane, 0) = bonusLane. A
    // REPLACE mode on a no-CPM deal can never change the payout.
    const r = rateOf({ cpmMode: "REPLACE" });
    const agg = computeAggregatePay([
      video({ bestViews: 120_000, rate: r }),
      video({ bestViews: 150_000, rate: r }),
    ]);
    expect(agg.totalPay.toNumber()).toBe(100); // max(50, 100) — unchanged
  });

  it("cpmMode REPLACE can never pay LESS than the lane alone (monotone max)", () => {
    // base only vs base + REPLACE-CPM: total never drops below the lane.
    const noCpm = rateOf({ ...NO_BONUS });
    const withCpm = rateOf({ ...NO_BONUS, ...flatCpm, cpmMode: "REPLACE" });
    const laneOnly = computeAggregatePay([video({ bestViews: 5_000, rate: noCpm })]);
    const composed = computeAggregatePay([video({ bestViews: 5_000, rate: withCpm })]);
    // lane = $25 base; cpm = $10 → max = 25 (the creator keeps the better).
    expect(laneOnly.totalPay.toNumber()).toBe(25);
    expect(composed.totalPay.toNumber()).toBe(25);
  });

  it("cpmMode rides the SAME latest-deal vote as the bonus table", () => {
    const oldDeal = rateOf({ ...flatCpm, cpmMode: "REPLACE" });
    const newDeal = rateOf({ ...flatCpm, cpmMode: "ADD" });
    const agg = computeAggregatePay([
      video({
        bestViews: 120_000,
        rate: oldDeal,
        postedAt: new Date("2026-05-01T00:00:00Z"),
      }),
      video({
        bestViews: 150_000,
        rate: newDeal,
        postedAt: new Date("2026-05-10T00:00:00Z"),
      }),
    ]);
    // Latest deal says ADD → bonusLane max(50,100)=100 PLUS cpm 540 = 640.
    expect(agg.cpmMode).toBe("ADD");
    expect(agg.totalPay.toNumber()).toBe(640);
  });

  it("legacy rate shape without cpmMode behaves as ADD", () => {
    const r = rateOf({ ...flatCpm });
    const legacy = { ...r } as Record<string, unknown>;
    delete legacy.cpmMode;
    const agg = computeAggregatePay([
      video({ bestViews: 120_000, rate: legacy as unknown as ResolvedRate }),
    ]);
    expect(agg.cpmMode).toBe("ADD");
    expect(agg.totalPay.toNumber()).toBe(100 + 240);
  });
});

describe("computeAggregatePay — cpmMinViews floor flows through the schedule", () => {
  const NO_BONUS = { viewBonuses: [] as { views: number; bonus: number }[] };

  it("the floor clips each video's own CPM (per-video, marginal)", () => {
    // $2/1k starting after 10k views: 50k views → 40k paid = $80.
    const r = rateOf({ ...NO_BONUS, ...flatCpm, cpmMinViews: 10_000 });
    const agg = computeAggregatePay([video({ bestViews: 50_000, rate: r })]);
    expect(agg.cpmPay.toNumber()).toBe(80);
    expect(agg.totalPay.toNumber()).toBe(25 + 80);
  });

  it("views below the floor pay $0 CPM (base pay unaffected)", () => {
    const r = rateOf({ ...NO_BONUS, ...flatCpm, cpmMinViews: 100_000 });
    const agg = computeAggregatePay([video({ bestViews: 50_000, rate: r })]);
    expect(agg.cpmPay.toNumber()).toBe(0);
    expect(agg.totalPay.toNumber()).toBe(25);
  });

  it("floor + cpmMode REPLACE combined: the floored CPM is what competes", () => {
    // Lane: base 25 (no bonuses). CPM $2/1k floor 10k on 50k views = $80.
    // REPLACE: max(25, 80) = 80.
    const r = rateOf({
      ...NO_BONUS,
      ...flatCpm,
      cpmMinViews: 10_000,
      tierEvaluationMode: "PER_VIDEO",
      cpmMode: "REPLACE",
    });
    const agg = computeAggregatePay([video({ bestViews: 50_000, rate: r })]);
    expect(agg.totalPay.toNumber()).toBe(80);
    // A higher floor flips the winner: floor 40k → cpm (50k−40k)×$2/1k = $20
    // → max(25, 20) = 25 (the creator keeps the better lane).
    const highFloor = rateOf({ ...r, cpmMinViews: 40_000 });
    const flipped = computeAggregatePay([
      video({ bestViews: 50_000, rate: highFloor }),
    ]);
    expect(flipped.cpmPay.toNumber()).toBe(20);
    expect(flipped.totalPay.toNumber()).toBe(25);
  });

  it("resolveRowRate: snapshot-first for cpmModeSnapshot + cpmMinViewsSnapshot", () => {
    const r = resolveRowRate(
      {
        paymentPerVideoSnapshot: new Decimal(25),
        basePayMinViewsSnapshot: 0,
        viewBonusesSnapshot: null,
        viewBonusModeSnapshot: "REPLACE",
        cpmRateSnapshot: new Decimal(2),
        cpmViewUnitSnapshot: 1000,
        cpmCapViewsSnapshot: null,
        cpmTiersSnapshot: null,
        cpmModeSnapshot: "REPLACE",
        cpmMinViewsSnapshot: 10_000,
        tierEvaluationModeSnapshot: "PER_VIDEO",
      },
      // Campaign has since been flipped back to ADD / no floor — the
      // snapshot must win (history never reprices).
      { ...fallback, viewBonuses: [], cpmMode: "ADD", cpmMinViews: null },
    );
    expect(r.cpmMode).toBe("REPLACE");
    expect(r.cpmMinViews).toBe(10_000);
    const agg = computeAggregatePay([video({ bestViews: 50_000, rate: r })]);
    // CPM (50k−10k)×$2/1k = 80 vs lane base 25 → 80.
    expect(agg.totalPay.toNumber()).toBe(80);
  });

  it("resolveRowRate: a pre-mode row shape (undefined columns) reads as ADD + no floor", () => {
    const r = resolveRowRate(
      {
        paymentPerVideoSnapshot: new Decimal(25),
        basePayMinViewsSnapshot: 0,
        viewBonusesSnapshot: null,
        viewBonusModeSnapshot: "REPLACE",
        cpmRateSnapshot: new Decimal(2),
        cpmViewUnitSnapshot: 1000,
        cpmCapViewsSnapshot: null,
        cpmTiersSnapshot: null,
      } as unknown as Parameters<typeof resolveRowRate>[0],
      fallback,
    );
    expect(r.cpmMode).toBe("ADD");
    expect(r.cpmMinViews).toBeNull();
    const agg = computeAggregatePay([video({ bestViews: 50_000, rate: r })]);
    expect(agg.totalPay.toNumber()).toBe(25 + 100); // exactly the old number
  });
});
