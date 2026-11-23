/**
 * Campaign earnings calculation.
 *
 * Pure, platform-agnostic helpers for computing creator pay from a matched
 * video's per-platform view counts. Earnings are driven by the video's
 * actual platform members (Instagram / TikTok / YouTube) — never a
 * hardcoded 2-platform list.
 */
import { toNum } from "@/lib/ugc/money";
import { computeCpmPay, type CpmTier } from "@/lib/ugc/pay-cpm";
import {
  groupPayViews,
  resolveViewAggregationMode,
} from "@/lib/ugc/pay-aggregate";

export interface ViewBonusTier {
  views: number;
  bonus: number;
}

export type { CpmTier } from "@/lib/ugc/pay-cpm";

/** The CPM component of a campaign rate (lib/pay-cpm.ts semantics). */
export interface CpmConfig {
  cpmRate: number | null;
  cpmViewUnit: number;
  cpmCapViews: number | null;
  cpmTiers: CpmTier[];
  /**
   * ADD (default) = CPM rides on top of base+bonus; REPLACE = the video pays
   * the better of the two lanes. Optional so legacy callers keep compiling.
   */
  cpmMode?: string | null;
  /** CPM starting floor — absent/null/0 = counts from the first view. */
  cpmMinViews?: number | null;
}

/** How a matched bonus tier combines with base pay. */
export type BonusMode = "REPLACE" | "ADD";

/** A platform post contributing views to a video, as far as pay is concerned. */
export interface EarningsVideoPost {
  platform: string;
  viewCount: number;
}

/**
 * Sums view counts per platform across a video's members.
 *
 * Platform keys are upper-cased so casing differences ("youtube" vs
 * "YOUTUBE") don't split a platform into two buckets. The returned values
 * are what `calcPay` tier-matches on — every connected platform must be
 * represented, including YouTube.
 */
export function viewsByPlatform(
  posts: ReadonlyArray<EarningsVideoPost>,
): Record<string, number> {
  return posts.reduce<Record<string, number>>((acc, p) => {
    const key = p.platform.toUpperCase();
    acc[key] = (acc[key] ?? 0) + p.viewCount;
    return acc;
  }, {});
}

/**
 * Returns the applicable pay for a video.
 *
 * Tier matching uses the highest single-platform view total by default
 * (Campaign.viewAggregationMode HIGHEST) so a video is rewarded for its best
 * performing platform; under COMBINED (stack 2) the platform totals SUM into
 * the payable count. `perPlatformViews` should come from
 * `Object.values(viewsByPlatform(posts))`; pass the campaign (or its
 * viewAggregationMode) via `options` — omitted = HIGHEST, byte-identical.
 *
 * The optional CPM component (lib/pay-cpm.ts) is computed on the same best
 * single-platform views. With cpmMode ADD (default) it rides ON TOP of the
 * base/bonus combination — bonus REPLACE only ever compares the bonus
 * against BASE pay, so a bonus never erases CPM earnings. With cpmMode
 * REPLACE the video pays the BETTER of (base/bonus combo) or CPM, mirroring
 * lib/pay-aggregate computeAggregatePay.
 */
export function calcPay(
  perPlatformViews: ReadonlyArray<number>,
  basePayPerVideo: number,
  tiers: ReadonlyArray<ViewBonusTier>,
  bonusMode: BonusMode = "REPLACE",
  basePayMinViews: number = 0,
  cpm?: CpmConfig,
  options?: { viewAggregationMode?: string | null },
): {
  pay: number;
  tier: ViewBonusTier | null;
  cpmPay: number;
  /**
   * The RAW, uncomposed lanes — what `composeCampaignTotal` sums before
   * applying the cpmMode composition ONCE across all videos. Under REPLACE
   * the per-video `pay` is only a row-level estimate; summing it inflates
   * campaign totals (sum of maxes >= max of sums — Bugbot, PR #341).
   */
  lanes: { baseBonus: number; cpm: number };
} {
  // Stack 2: payable views — max under HIGHEST (byte-identical), sum under
  // COMBINED. `Math.max(0, …)` guard kept for empty input.
  const bestViews = Math.max(
    0,
    groupPayViews(perPlatformViews, resolveViewAggregationMode(options)),
  );
  // Base pay requires minimum views (0 = no minimum).
  const basePay =
    basePayMinViews > 0 && bestViews < basePayMinViews ? 0 : basePayPerVideo;
  const sorted = [...tiers].sort((a, b) => a.views - b.views);
  let matchedTier: ViewBonusTier | null = null;
  for (const tier of sorted) {
    if (bestViews >= tier.views) {
      matchedTier = tier;
    }
  }
  // CPM is NOT gated by the base-pay min-views (it already scales with
  // views; the schedule applies its own cpmMinViews floor). Decimal math
  // inside computeCpmPay; collapsed at this display boundary.
  const cpmPay = cpm
    ? toNum(
        computeCpmPay(bestViews, {
          ratePerUnit: cpm.cpmRate,
          viewUnit: cpm.cpmViewUnit,
          capViews: cpm.cpmCapViews,
          tiers: cpm.cpmTiers,
          minViews: cpm.cpmMinViews ?? null,
        }),
      )
    : 0;
  const baseAndBonus = matchedTier
    ? bonusMode === "ADD"
      ? basePay + matchedTier.bonus
      : Math.max(basePay, matchedTier.bonus)
    : basePay;
  // cpmMode composition (mirrors lib/pay-aggregate computeAggregatePay):
  // ADD = CPM on top; REPLACE = the better of the two lanes. The returned
  // cpmPay is the CPM lane's CONTRIBUTION to `pay` (so callers' line items
  // still sum: under REPLACE the losing lane contributes $0), not the raw
  // lane value.
  const lanes = { baseBonus: baseAndBonus, cpm: cpmPay };
  if (cpm?.cpmMode === "REPLACE") {
    const cpmWins = cpmPay > baseAndBonus;
    return {
      pay: cpmWins ? cpmPay : baseAndBonus,
      tier: matchedTier,
      cpmPay: cpmWins ? cpmPay : 0,
      lanes,
    };
  }
  return { pay: baseAndBonus + cpmPay, tier: matchedTier, cpmPay, lanes };
}

/**
 * Campaign-level total across videos, composing the cpmMode ONCE on the lane
 * SUMS — mirroring lib/pay-aggregate computeAggregatePay. REPLACE is
 * non-additive (max), so summing per-video composed pay overstates the total
 * whenever some videos are base-dominant and others CPM-dominant (Bugbot,
 * PR #341). ADD reduces to the plain sum.
 *
 * VIDEO PAY ONLY — deliberately excludes the Stack 2 retainer. A retainer is
 * paid per PAY CYCLE, and none of the estimate surfaces that call this know
 * how many cycles have elapsed (PayCycle rows only exist once a brand creates
 * them, retainerAmount is mutable, and there is no proration). Folding a
 * single cycle's retainer into a lifetime total produces a number that is
 * systematically N× low while looking authoritative, so the retainer is
 * surfaced as its own clearly-labelled per-cycle line instead. The accrued
 * truth lives in the ledger (PayCycleEntry.retainerPay).
 */
export function composeCampaignTotal(
  rows: ReadonlyArray<{ lanes: { baseBonus: number; cpm: number } }>,
  cpmMode?: string | null,
): number {
  let composed: number;
  if (cpmMode === "REPLACE") {
    let baseBonus = 0;
    let cpm = 0;
    for (const r of rows) {
      baseBonus += r.lanes.baseBonus;
      cpm += r.lanes.cpm;
    }
    composed = Math.max(baseBonus, cpm);
  } else {
    let total = 0;
    for (const r of rows) total += r.lanes.baseBonus + r.lanes.cpm;
    composed = total;
  }
  return composed;
}
