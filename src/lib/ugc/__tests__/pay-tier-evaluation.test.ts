/**
 * Tests for the brand-selectable CPM tier-evaluation mode
 * (feat/tier-evaluation-mode).
 *
 * Only the CPM rate-tier lane changes by mode; base pay stays per-video and the
 * view bonus stays cumulative. The canonical money is computeAggregatePay
 * (lib/pay-aggregate.ts) — what the pay cycle actually pays — plus the low-level
 * computeCombinedCpmPay helper (lib/pay-cpm.ts).
 *
 * WORKED EXAMPLE (brief): $5 per 1,000 views up to 500k, then $8 per 1,000
 * above. A creator whose period videos sum to 700k best-platform views:
 *   PER_VIDEO (5×140k): each 140k×$5/1k = $700 → $3,500 (never reaches 500k).
 *   COMBINED_BRACKETED: 500k×$5/1k + 200k×$8/1k = $2,500 + $1,600 = $4,100.
 *   COMBINED_FLAT:      700k×$8/1k = $5,600.
 *
 * Every money assertion checks EXACT cents.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  computeCombinedCpmPay,
  isCombinedTierMode,
  type CpmSchedule,
} from "@/lib/ugc/pay-cpm";
import {
  computeAggregatePay,
  resolveRowRate,
  type AggregateVideoInput,
  type ResolvedRate,
  type FallbackRate,
  type RateSnapshotRow,
} from "@/lib/ugc/pay-aggregate";
import { violatesFlatMonotonicRates } from "@/lib/ugc/pay-validation";

// $5/1k up to 500k, then $8/1k above — the brief's worked example schedule.
const SCHEDULE: CpmSchedule = {
  ratePerUnit: 5,
  viewUnit: 1000,
  capViews: null,
  tiers: [{ views: 500_000, ratePerUnit: 8 }],
  minViews: null,
};

/**
 * A CPM-only ResolvedRate (no base pay, no bonus) so totalPay === cpmPay and the
 * tests isolate the CPM tier lane. `mode` picks the tier-evaluation behavior.
 */
function cpmRate(mode: string, over: Partial<ResolvedRate> = {}): ResolvedRate {
  return {
    paymentPerVideo: 0,
    basePayMinViews: 0,
    viewBonuses: [],
    viewBonusMode: "REPLACE",
    cpmRatePerUnit: 5,
    cpmViewUnit: 1000,
    cpmCapViews: null,
    cpmTiers: [{ views: 500_000, ratePerUnit: 8 }],
    cpmMode: "ADD",
    cpmMinViews: null,
    tierEvaluationMode: mode,
    ...over,
  };
}

function video(bestViews: number, rate: ResolvedRate, over: Partial<AggregateVideoInput> = {}): AggregateVideoInput {
  return {
    bestViews,
    rate,
    override: null,
    excluded: false,
    postedAt: new Date("2026-05-01T00:00:00Z"),
    dealKey: "d0",
    ...over,
  };
}

const cents = (d: Decimal) => d.toNumber();

describe("computeCombinedCpmPay (lib/pay-cpm.ts helper)", () => {
  it("COMBINED_BRACKETED on 700k = 500k×$5/1k + 200k×$8/1k = $4,100", () => {
    expect(cents(computeCombinedCpmPay(700_000, SCHEDULE, "COMBINED_BRACKETED"))).toBe(4100);
  });

  it("COMBINED_FLAT on 700k reprices ALL views at $8/1k = $5,600", () => {
    expect(cents(computeCombinedCpmPay(700_000, SCHEDULE, "COMBINED_FLAT"))).toBe(5600);
  });

  it("at EXACTLY the threshold (500k) neither mode has crossed → base $5/1k = $2,500", () => {
    expect(cents(computeCombinedCpmPay(500_000, SCHEDULE, "COMBINED_BRACKETED"))).toBe(2500);
    expect(cents(computeCombinedCpmPay(500_000, SCHEDULE, "COMBINED_FLAT"))).toBe(2500);
  });

  it("ONE view over threshold (500,001): BRACKETED = $2,500.01, FLAT jumps to $8/1k = $4,000.01", () => {
    // BRACKETED: 500k×$5/1k + 1×$8/1k = 2500 + 0.008 → 2500.01 (half-up cents).
    expect(cents(computeCombinedCpmPay(500_001, SCHEDULE, "COMBINED_BRACKETED"))).toBe(2500.01);
    // FLAT: crossed → 500,001×$8/1k = 4000.008 → 4000.01.
    expect(cents(computeCombinedCpmPay(500_001, SCHEDULE, "COMBINED_FLAT"))).toBe(4000.01);
  });

  it("below the first tier both modes are the plain base/cap calc", () => {
    // 300k < 500k → base rate only, no tier engaged, in BOTH modes.
    expect(cents(computeCombinedCpmPay(300_000, SCHEDULE, "COMBINED_BRACKETED"))).toBe(1500);
    expect(cents(computeCombinedCpmPay(300_000, SCHEDULE, "COMBINED_FLAT"))).toBe(1500);
  });

  it("multi-tier (3+ tiers) walks correctly: $5→$8→$10 at 500k/1M", () => {
    const multi: CpmSchedule = {
      ratePerUnit: 5,
      viewUnit: 1000,
      capViews: null,
      tiers: [
        { views: 500_000, ratePerUnit: 8 },
        { views: 1_000_000, ratePerUnit: 10 },
      ],
      minViews: null,
    };
    // BRACKETED @1.2M: 500k×5 + 500k×8 + 200k×10 = 2500 + 4000 + 2000 = 8500.
    expect(cents(computeCombinedCpmPay(1_200_000, multi, "COMBINED_BRACKETED"))).toBe(8500);
    // FLAT @1.2M: highest crossed tier = 1M ($10) → 1.2M×$10/1k = 12,000.
    expect(cents(computeCombinedCpmPay(1_200_000, multi, "COMBINED_FLAT"))).toBe(12000);
  });

  it("COMBINED_FLAT honors the cpmMinViews floor (views below the floor pay $0)", () => {
    const floored: CpmSchedule = { ...SCHEDULE, minViews: 100_000 };
    // Crossed 500k → $8/1k on (700k − 100k floor) = 600k → $4,800.
    expect(cents(computeCombinedCpmPay(700_000, floored, "COMBINED_FLAT"))).toBe(4800);
  });

  it("COMBINED_FLAT DROPS the cap once a tier is crossed (retroactive repricing spans all views)", () => {
    // Cap 400k, tier at 500k. The FLAT crossing check compares RAW cumulative
    // views (700k) to the threshold (500k) — cap does not gate the crossing.
    // Crossed → ALL 700k reprice at $8/1k = $5,600, cap dropped (NOT
    // 400k-capped $3,200, and NOT the marginal BRACKETED $4,100).
    const capped: CpmSchedule = { ...SCHEDULE, capViews: 400_000 };
    expect(cents(computeCombinedCpmPay(700_000, capped, "COMBINED_FLAT"))).toBe(5600);
    // Sanity: BRACKETED on the SAME capped schedule keeps the cap on the BASE
    // segment only — the cap does NOT gate the tier segments. Base [0,400k]×$5
    // = $2,000; the cap→tier dead zone (400k–500k) pays nothing; the tier
    // segment 500k–700k still engages ×$8 = $1,600 → $3,600 (≠ FLAT's $5,600).
    expect(cents(computeCombinedCpmPay(700_000, capped, "COMBINED_BRACKETED"))).toBe(3600);
  });

  it("COMBINED_FLAT APPLIES the cap when NO tier is crossed (cap shortens the base segment)", () => {
    // Cap 250k, 300k cumulative views, tier at 500k NOT crossed → identical to
    // the plain marginal/cap calc: only the first 250k pay ($5/1k) = $1,250,
    // NOT the uncapped 300k×$5 = $1,500.
    const capped: CpmSchedule = { ...SCHEDULE, capViews: 250_000 };
    expect(cents(computeCombinedCpmPay(300_000, capped, "COMBINED_FLAT"))).toBe(1250);
    expect(cents(computeCombinedCpmPay(300_000, capped, "COMBINED_BRACKETED"))).toBe(1250);
  });

  it("isCombinedTierMode narrows only the two combined modes", () => {
    expect(isCombinedTierMode("PER_VIDEO")).toBe(false);
    expect(isCombinedTierMode(null)).toBe(false);
    expect(isCombinedTierMode(undefined)).toBe(false);
    expect(isCombinedTierMode("COMBINED_BRACKETED")).toBe(true);
    expect(isCombinedTierMode("COMBINED_FLAT")).toBe(true);
  });
});

describe("computeAggregatePay — tier-evaluation mode (the canonical payout)", () => {
  it("PER_VIDEO (default): five 140k videos each price alone → $3,500, never the 500k tier", () => {
    const rate = cpmRate("PER_VIDEO");
    const vids = Array.from({ length: 5 }, () => video(140_000, rate));
    const agg = computeAggregatePay(vids);
    expect(cents(agg.cpmPay)).toBe(3500);
    expect(cents(agg.totalPay)).toBe(3500);
    expect(agg.tierEvaluationMode).toBe("PER_VIDEO");
  });

  it("COMBINED_BRACKETED: the same 5×140k = 700k cumulative → $4,100 (marginal)", () => {
    const rate = cpmRate("COMBINED_BRACKETED");
    const vids = Array.from({ length: 5 }, () => video(140_000, rate));
    const agg = computeAggregatePay(vids);
    expect(cents(agg.cpmPay)).toBe(4100);
    expect(cents(agg.totalPay)).toBe(4100);
    expect(agg.tierEvaluationMode).toBe("COMBINED_BRACKETED");
  });

  it("COMBINED_FLAT: the same 5×140k = 700k cumulative → $5,600 (retroactive)", () => {
    const rate = cpmRate("COMBINED_FLAT");
    const vids = Array.from({ length: 5 }, () => video(140_000, rate));
    const agg = computeAggregatePay(vids);
    expect(cents(agg.cpmPay)).toBe(5600);
    expect(cents(agg.totalPay)).toBe(5600);
  });

  it("BOUNDARY: cumulative EXACTLY 500k (5×100k) → $2,500 in ALL three modes", () => {
    for (const mode of ["PER_VIDEO", "COMBINED_BRACKETED", "COMBINED_FLAT"]) {
      const rate = cpmRate(mode);
      const vids = Array.from({ length: 5 }, () => video(100_000, rate));
      expect(cents(computeAggregatePay(vids).cpmPay)).toBe(2500);
    }
  });

  it("single video OVER threshold in COMBINED modes prices on its own (== cumulative) views", () => {
    // One 500,001-view video. BRACKETED = $2,500.01, FLAT = $4,000.01.
    expect(
      cents(computeAggregatePay([video(500_001, cpmRate("COMBINED_BRACKETED"))]).cpmPay),
    ).toBe(2500.01);
    expect(
      cents(computeAggregatePay([video(500_001, cpmRate("COMBINED_FLAT"))]).cpmPay),
    ).toBe(4000.01);
  });

  it("BACK-COMPAT: an unset (defaulted) mode behaves EXACTLY like PER_VIDEO", () => {
    // A rate whose tierEvaluationMode is the schema default. Must match the
    // explicit PER_VIDEO run byte-for-byte (five 140k videos → $3,500).
    const def = cpmRate("PER_VIDEO");
    const vids = Array.from({ length: 5 }, () => video(140_000, def));
    const agg = computeAggregatePay(vids);
    // If the default were wrongly COMBINED, this would be $4,100 or $5,600.
    expect(cents(agg.cpmPay)).toBe(3500);
  });

  it("mode + combined schedule are VOTED from the chronologically-latest deal", () => {
    // Older video carries PER_VIDEO; the LATEST carries COMBINED_FLAT. The whole
    // creator prices under the latest deal → FLAT on 700k = $5,600.
    const older = video(140_000, cpmRate("PER_VIDEO"), {
      postedAt: new Date("2026-05-01T00:00:00Z"),
    });
    const laterVids = Array.from({ length: 4 }, () =>
      video(140_000, cpmRate("COMBINED_FLAT"), {
        postedAt: new Date("2026-05-10T00:00:00Z"),
      }),
    );
    const agg = computeAggregatePay([older, ...laterVids]);
    expect(agg.tierEvaluationMode).toBe("COMBINED_FLAT");
    expect(cents(agg.cpmPay)).toBe(5600);
  });

  it("COMBINED cumulative EXCLUDES overridden + excluded videos from the CPM tier walk", () => {
    const rate = cpmRate("COMBINED_BRACKETED");
    const agg = computeAggregatePay([
      video(300_000, rate), // counts
      video(400_000, rate), // counts → cumulative 700k
      video(600_000, rate, { override: new Decimal(999) }), // override: no CPM, views not in CPM cumulative
      video(900_000, rate, { excluded: true }), // excluded: nothing
    ]);
    // CPM tier walk sees ONLY 300k + 400k = 700k → $4,100. The override rides on
    // top of totalPay; CPM itself is $4,100.
    expect(cents(agg.cpmPay)).toBe(4100);
    expect(cents(agg.totalPay)).toBe(4100 + 999);
  });

  it("base pay + view bonus are UNCHANGED across all three modes (only CPM tiers move)", () => {
    // Add base pay ($10/video, min 0) + a $200 bonus at 500k cumulative.
    const base = { paymentPerVideo: 10, viewBonuses: [{ views: 500_000, bonus: 200 }] };
    const results = ["PER_VIDEO", "COMBINED_BRACKETED", "COMBINED_FLAT"].map((mode) => {
      const rate = cpmRate(mode, base);
      const vids = Array.from({ length: 5 }, () => video(140_000, rate));
      return computeAggregatePay(vids);
    });
    for (const agg of results) {
      // Base: 5 videos × $10 (all clear min 0) = $50 — same every mode.
      expect(cents(agg.basePaySum)).toBe(50);
      // Bonus: cumulative 700k ≥ 500k → $200 — same every mode.
      expect(cents(agg.bonusPay)).toBe(200);
    }
    // Only the CPM lane differs: 3500 / 4100 / 5600.
    expect(cents(results[0].cpmPay)).toBe(3500);
    expect(cents(results[1].cpmPay)).toBe(4100);
    expect(cents(results[2].cpmPay)).toBe(5600);
    // totalPay = max(base, bonus) [REPLACE bonus] + cpm [ADD]. base 50 vs bonus
    // 200 → 200; + cpm. Confirms bonus/base composition is mode-independent.
    expect(cents(results[0].totalPay)).toBe(200 + 3500);
    expect(cents(results[1].totalPay)).toBe(200 + 4100);
    expect(cents(results[2].totalPay)).toBe(200 + 5600);
  });
});

// ─── F2: the mode snapshot pins history through a campaign edit ──────────────
describe("resolveRowRate — tier-evaluation mode snapshot honored independently (F2)", () => {
  const snapshotlessRow = (mode: string): RateSnapshotRow => ({
    // ALL legacy pay-component snapshots null → hasSnapshot=false → the rate
    // falls back to the campaign. Only the mode snapshot is set (the migration
    // backfilled it NOT NULL DEFAULT on every existing row).
    paymentPerVideoSnapshot: null,
    basePayMinViewsSnapshot: 0,
    viewBonusesSnapshot: null,
    viewBonusModeSnapshot: "REPLACE",
    cpmRateSnapshot: null,
    cpmViewUnitSnapshot: 1000,
    cpmCapViewsSnapshot: null,
    cpmTiersSnapshot: null,
    cpmModeSnapshot: "ADD",
    cpmMinViewsSnapshot: null,
    tierEvaluationModeSnapshot: mode,
  });

  const combinedFallback: FallbackRate = {
    paymentPerVideo: 0,
    basePayMinViews: 0,
    viewBonuses: [],
    viewBonusMode: "REPLACE",
    cpmRatePerUnit: 5,
    cpmViewUnit: 1000,
    cpmCapViews: null,
    cpmTiers: [{ views: 500_000, ratePerUnit: 8 }],
    cpmMode: "ADD",
    cpmMinViews: null,
    tierEvaluationMode: "COMBINED_FLAT",
  };

  it("a snapshotless legacy row pins its OWN mode (PER_VIDEO) over the campaign's current COMBINED", () => {
    const rate = resolveRowRate(snapshotlessRow("PER_VIDEO"), combinedFallback);
    expect(rate.tierEvaluationMode).toBe("PER_VIDEO");
    // The REST of the rate still falls back (no CPM snapshot) — only the MODE is
    // pinned. This is what keeps history from being repriced by a mode flip.
    expect(rate.cpmRatePerUnit).toBe(5);
  });

  it("an undefined row (no PlatformPost at all) falls through to the campaign's mode", () => {
    expect(resolveRowRate(undefined, combinedFallback).tierEvaluationMode).toBe(
      "COMBINED_FLAT",
    );
  });

  it("historical rows are NOT retroactively repriced when the brand flips to COMBINED_FLAT", () => {
    // Two 350k videos snapshotted PER_VIDEO; the campaign is now FLAT.
    // Per-video: 350k×$5/1k = $1,750 each → $3,500. Pre-F2 (mode discarded) the
    // vote would resolve FLAT → 700k×$8/1k = $5,600, silently repricing paid
    // history on the next recompute.
    const rate = resolveRowRate(snapshotlessRow("PER_VIDEO"), combinedFallback);
    const agg = computeAggregatePay([
      video(350_000, rate, { postedAt: new Date("2026-05-01T00:00:00Z"), dealKey: "a" }),
      video(350_000, rate, { postedAt: new Date("2026-05-02T00:00:00Z"), dealKey: "b" }),
    ]);
    expect(cents(agg.cpmPay)).toBe(3500);
  });
});

// ─── F3: deterministic latest-deal vote on tied timestamps ───────────────────
describe("computeAggregatePay — deterministic vote on tied postedAt (F3)", () => {
  it("equal-timestamp rows pay IDENTICALLY regardless of array order", () => {
    const tie = new Date("2026-05-05T00:00:00Z");
    const perVideo = video(350_000, cpmRate("PER_VIDEO"), { postedAt: tie, dealKey: "aaa" });
    const flat = video(350_000, cpmRate("COMBINED_FLAT"), { postedAt: tie, dealKey: "bbb" });

    const forward = computeAggregatePay([perVideo, flat]);
    const reversed = computeAggregatePay([flat, perVideo]);

    // Order-independent: both the voted mode AND the money match.
    expect(forward.tierEvaluationMode).toBe(reversed.tierEvaluationMode);
    expect(cents(forward.cpmPay)).toBe(cents(reversed.cpmPay));
    // The larger dealKey ("bbb") deterministically wins the tie → FLAT on 700k.
    expect(forward.tierEvaluationMode).toBe("COMBINED_FLAT");
    expect(cents(forward.cpmPay)).toBe(5600);
  });

  it("multiple UNDATED legacy rows also resolve order-independently (dealKey tie-break)", () => {
    const perVideo = video(350_000, cpmRate("PER_VIDEO"), { postedAt: null, dealKey: "k1" });
    const flat = video(350_000, cpmRate("COMBINED_FLAT"), { postedAt: null, dealKey: "k2" });
    const forward = computeAggregatePay([perVideo, flat]);
    const reversed = computeAggregatePay([flat, perVideo]);
    expect(cents(forward.cpmPay)).toBe(cents(reversed.cpmPay));
  });
});

// ─── F5: COMBINED_FLAT monotonic-rate guard (pure helper) ────────────────────
describe("violatesFlatMonotonicRates (F5)", () => {
  it("flags a tier rate BELOW the base rate", () => {
    expect(
      violatesFlatMonotonicRates({
        cpmRate: 5,
        cpmTiers: [{ views: 500_000, ratePerUnit: 1 }],
      }),
    ).toBe(true);
  });

  it("flags a downward step BETWEEN tiers", () => {
    expect(
      violatesFlatMonotonicRates({
        cpmRate: 5,
        cpmTiers: [
          { views: 500_000, ratePerUnit: 8 },
          { views: 1_000_000, ratePerUnit: 6 },
        ],
      }),
    ).toBe(true);
  });

  it("evaluates in THRESHOLD order, not array order", () => {
    expect(
      violatesFlatMonotonicRates({
        cpmRate: 5,
        cpmTiers: [
          { views: 1_000_000, ratePerUnit: 10 }, // listed first, higher threshold
          { views: 500_000, ratePerUnit: 1 }, // lower threshold, drops below base
        ],
      }),
    ).toBe(true);
  });

  it("accepts non-decreasing rates (equal allowed)", () => {
    expect(
      violatesFlatMonotonicRates({
        cpmRate: 5,
        cpmTiers: [
          { views: 500_000, ratePerUnit: 5 },
          { views: 1_000_000, ratePerUnit: 10 },
        ],
      }),
    ).toBe(false);
  });

  it("no tiers → nothing to cross → not a violation", () => {
    expect(violatesFlatMonotonicRates({ cpmRate: 5, cpmTiers: null })).toBe(false);
    expect(violatesFlatMonotonicRates({ cpmRate: 5, cpmTiers: [] })).toBe(false);
  });

  it("tiers-only schedule (null base = floor 0) with non-decreasing tiers is fine", () => {
    expect(
      violatesFlatMonotonicRates({
        cpmRate: null,
        cpmTiers: [{ views: 500_000, ratePerUnit: 8 }],
      }),
    ).toBe(false);
  });
});
