/**
 * Rate resolution + the per-deal (aggregate) pay model.
 *
 * Ported from Ripple lib/pay-aggregate.ts (Prisma.Decimal → decimal.js; math
 * unchanged). In Hydra this is the PER-DEAL model, a deal setting
 * (`deals.per_deal_model`, off by default). The default is the per-video model,
 * `calcPay` in campaign-earnings.ts. `resolveRowRate` and `groupPayViews` serve
 * both models.
 *
 * The canonical model (do NOT diverge from it):
 *   - A video is paid ONCE, on its best (most-viewed) platform.
 *   - A deal COMPOSES any subset of three components (mix-and-match):
 *       1. BASE pay — per-video, gated by that video's min-views threshold.
 *       2. CPM — per-video: the video's best-platform views run through the
 *          piecewise schedule in lib/pay-cpm.ts (rate per view-unit,
 *          optional cap, optional marginal tiers). NOT gated by min-views —
 *          CPM already scales with views by construction.
 *       3. VIEW BONUSES — ONE aggregate tier matched on the creator's summed
 *          non-excluded best-platform views for the whole period — never
 *          per-video.
 *   - excludeFromEarnings → the whole video earns $0 (no base, no CPM) and
 *     its views do NOT count toward the bonus aggregate.
 *   - manualEarningsOverride wins for that video (no base/CPM/bonus on it)
 *     but its views STILL count toward the aggregate.
 *   - The bonus-tier TABLE is snapshotted deterministically from the
 *     chronologically-latest non-excluded video (the "latest deal").
 *   - BONUS REPLACE/ADD semantics — REPLACE replaces BASE PAY ONLY:
 *       REPLACE: bonusLane = max(baseSum, aggregateBonus)
 *       STACK:   bonusLane = baseSum + aggregateBonus
 *     A bonus NEVER erases CPM earnings: the max() comparison is strictly
 *     between the base-pay sum and the bonus.
 *   - CPM MODE (cpmMode, picked from the same latest-deal vote as the bonus
 *     mode) decides how the CPM lane composes with that bonus lane:
 *       ADD (default, today's behavior):
 *         totalPay = bonusLane + cpmSum + overrideSum
 *       REPLACE (the creator earns the BETTER of the two lanes — max(),
 *       mirroring viewBonusMode REPLACE's convention; a mode existing can
 *       never pay LESS):
 *         totalPay = max(bonusLane, cpmSum) + overrideSum
 *     (Pinned by lib/__tests__/pay-aggregate.test.ts.)
 *
 * Money stays in Decimal end-to-end (no float drift); callers collapse to
 * integer cents at the boundary with money.ts toCents.
 */
import Decimal from "decimal.js";
import { toNum, toNumOrNull } from "@/lib/ugc/money";
import {
  computeCpmPay,
  computeCombinedCpmPay,
  isCombinedTierMode,
  sanitizeCpmTiers,
  type CpmTier,
} from "@/lib/ugc/pay-cpm";

export interface ViewBonus {
  views: number;
  bonus: number;
}

export interface ResolvedRate {
  paymentPerVideo: number;
  basePayMinViews: number;
  viewBonuses: ViewBonus[];
  viewBonusMode: string;
  /** CPM component — null rate + empty tiers = no CPM on this deal. */
  cpmRatePerUnit: number | null;
  cpmViewUnit: number;
  cpmCapViews: number | null;
  cpmTiers: CpmTier[];
  /** ADD (CPM rides on top) | REPLACE (better of the two lanes). */
  cpmMode: string;
  /** CPM starting floor — null/0 = counts from the first view. */
  cpmMinViews: number | null;
  /**
   * How the CPM rate TIERS are evaluated across the creator's period videos:
   * PER_VIDEO (default, today's behavior) | COMBINED_BRACKETED | COMBINED_FLAT.
   * Composition happens ONCE at the aggregate level (like cpmMode), so the
   * mode is voted from the latest deal in computeAggregatePay.
   */
  tierEvaluationMode: string;
}

/** The campaign's CURRENT rate, used when a row carries no snapshot. */
export interface FallbackRate {
  paymentPerVideo: number;
  basePayMinViews: number;
  viewBonuses: ViewBonus[];
  viewBonusMode: string;
  cpmRatePerUnit: number | null;
  cpmViewUnit: number;
  cpmCapViews: number | null;
  cpmTiers: CpmTier[];
  cpmMode: string;
  cpmMinViews: number | null;
  tierEvaluationMode: string;
}

/** The snapshot columns a PlatformPost row carries from sync time. */
export interface RateSnapshotRow {
  paymentPerVideoSnapshot: Decimal | null;
  basePayMinViewsSnapshot: number;
  viewBonusesSnapshot: unknown | null;
  viewBonusModeSnapshot: string;
  cpmRateSnapshot: Decimal | null;
  cpmViewUnitSnapshot: number;
  cpmCapViewsSnapshot: number | null;
  cpmTiersSnapshot: unknown | null;
  cpmModeSnapshot: string;
  cpmMinViewsSnapshot: number | null;
  tierEvaluationModeSnapshot: string;
}

/**
 * Resolve the pay rate for a single platform-post row from its snapshot,
 * falling back to the campaign's current rate when the row has no snapshot
 * (legacy posts) or is missing. Each row keeps the rate active when it synced,
 * so a mid-cycle rate change applies only to posts after it.
 *
 * "Has a snapshot" = ANY pay component was captured at sync time (base pay,
 * bonuses, OR a CPM rate/tier schedule) — a CPM-only deal must not fall back
 * to the campaign's current rate.
 *
 * Presence derives from RAW column nullness, never from sanitized/parsed
 * emptiness: an explicit empty array ([] = "bonuses/tiers disabled at sync
 * time", e.g. via a per-creator override) IS a snapshot. Treating it as "no
 * snapshot" would silently fall back to the campaign's CURRENT rates and
 * resurrect disabled bonuses (Codex HIGH, PR #280).
 */
export function resolveRowRate(
  row: RateSnapshotRow | undefined,
  fallback: FallbackRate,
): ResolvedRate {
  if (row) {
    const bonuses = (row.viewBonusesSnapshot as ViewBonus[] | null) ?? null;
    // `?? null` everywhere — INCLUDING the base-pay column: a row shape
    // minted before the CPM columns (or a narrower select) reads missing
    // columns as undefined, and undefined must mean "no snapshot", never
    // "has a snapshot". Without the base-pay guard, an undefined
    // paymentPerVideoSnapshot passed `!== null` and registered as a $0-base
    // snapshot, silently paying nothing (adversarial review finding 3,
    // PR #280).
    const paymentSnapshot = row.paymentPerVideoSnapshot ?? null;
    const cpmRateSnapshot = row.cpmRateSnapshot ?? null;
    const rawCpmTiers = (row.cpmTiersSnapshot as CpmTier[] | null) ?? null;
    const cpmTiers = sanitizeCpmTiers(rawCpmTiers);
    const hasSnapshot =
      paymentSnapshot !== null ||
      bonuses !== null ||
      cpmRateSnapshot !== null ||
      rawCpmTiers !== null;
    if (hasSnapshot) {
      return {
        // Decimal snapshot columns → plain numbers for this single rate.
        paymentPerVideo: toNum(paymentSnapshot),
        basePayMinViews: row.basePayMinViewsSnapshot,
        viewBonuses: bonuses ?? [],
        viewBonusMode: row.viewBonusModeSnapshot,
        cpmRatePerUnit: toNumOrNull(cpmRateSnapshot),
        cpmViewUnit: row.cpmViewUnitSnapshot ?? 1000,
        cpmCapViews: row.cpmCapViewsSnapshot ?? null,
        cpmTiers,
        // `?? "ADD"` / `?? null`: a row shape minted before these columns
        // (narrow select / legacy fixture) must read as today's behavior —
        // CPM adds on top and counts from view zero.
        cpmMode: row.cpmModeSnapshot ?? "ADD",
        cpmMinViews: row.cpmMinViewsSnapshot ?? null,
        // `?? "PER_VIDEO"`: a legacy/narrow row (undefined column) reads as
        // today's behavior — each video walks the tiers on its own views.
        tierEvaluationMode: row.tierEvaluationModeSnapshot ?? "PER_VIDEO",
      };
    }
  }
  return {
    paymentPerVideo: fallback.paymentPerVideo,
    basePayMinViews: fallback.basePayMinViews,
    viewBonuses: fallback.viewBonuses,
    viewBonusMode: fallback.viewBonusMode,
    cpmRatePerUnit: fallback.cpmRatePerUnit,
    cpmViewUnit: fallback.cpmViewUnit,
    cpmCapViews: fallback.cpmCapViews,
    cpmTiers: fallback.cpmTiers,
    cpmMode: fallback.cpmMode ?? "ADD",
    cpmMinViews: fallback.cpmMinViews ?? null,
    // The tier-evaluation mode is snapshotted INDEPENDENTLY of the legacy
    // pay-component gate above: the migration backfilled EVERY existing row to
    // "PER_VIDEO", so a row's OWN non-null mode snapshot must pin that row's
    // mode even when it carries no base/bonus/CPM snapshot. Otherwise a
    // snapshotless historical row falls through to the campaign's CURRENT mode
    // and flipping a campaign to a COMBINED mode retroactively reprices paid
    // history (F2). Only a genuinely absent snapshot (row undefined, or a
    // narrow select that omitted the column) falls through to the campaign.
    tierEvaluationMode:
      (row?.tierEvaluationModeSnapshot ?? fallback.tierEvaluationMode) ??
      "PER_VIDEO",
  };
}

// ─── View aggregation across platforms (stack 2) ─────────────────────────────
//
// Campaign.viewAggregationMode decides how a cross-platform video group's
// views feed pay math at EVERY consumer site (pay cycle, finances,
// video-earnings breakdown, posts/[id] attribution, dashboard earnings,
// campaign revenue panel):
//   HIGHEST (default, today's behavior) — the best (most-viewed) platform's
//     count is the video's payable views.
//   COMBINED — the group's platform views SUM into the payable count.
// The mode is a LIVE campaign policy (deliberately NOT snapshotted per post —
// it is a counting rule, not a deal term); the best row still supplies the
// rate / dealKey / postedAt exactly as before, only the VIEWS number changes.

export type ViewAggregationMode = "HIGHEST" | "COMBINED";

/**
 * Resolve a campaign's view-aggregation mode. Anything but the exact string
 * "COMBINED" (null, undefined, absent column, legacy garbage) is HIGHEST —
 * fail-closed to today's behavior.
 */
export function resolveViewAggregationMode(
  campaign?: { viewAggregationMode?: string | null } | null,
): ViewAggregationMode {
  return campaign?.viewAggregationMode === "COMBINED" ? "COMBINED" : "HIGHEST";
}

/**
 * Collapse one video group's per-platform view counts to its PAYABLE views:
 * max under HIGHEST (byte-identical to the historical best-platform rule),
 * sum under COMBINED. Empty input is 0 in both modes.
 */
export function groupPayViews(
  viewCounts: readonly number[],
  mode: ViewAggregationMode,
): number {
  if (viewCounts.length === 0) return 0;
  if (mode === "COMBINED") {
    let sum = 0;
    for (const v of viewCounts) sum += v;
    return sum;
  }
  let max = viewCounts[0];
  for (const v of viewCounts) if (v > max) max = v;
  return max;
}

/**
 * The CPM earnings for one video under a resolved rate. Thin adapter over
 * lib/pay-cpm computeCpmPay so every caller maps ResolvedRate → CpmSchedule
 * identically. Returns whole-cent Decimal (0 when the deal has no CPM).
 */
export function cpmPayForRate(
  views: number,
  rate: Pick<
    ResolvedRate,
    "cpmRatePerUnit" | "cpmViewUnit" | "cpmCapViews" | "cpmTiers"
  > &
    Partial<Pick<ResolvedRate, "cpmMinViews">>,
): Decimal {
  return computeCpmPay(views, {
    ratePerUnit: rate.cpmRatePerUnit,
    viewUnit: rate.cpmViewUnit,
    capViews: rate.cpmCapViews,
    tiers: rate.cpmTiers,
    minViews: rate.cpmMinViews ?? null,
  });
}

/**
 * One video group reduced to the fields the aggregate math needs. The caller
 * has already collapsed a cross-platform group to its best (most-viewed)
 * platform.
 */
export interface AggregateVideoInput {
  /** Best (most-viewed) platform's views for this video. */
  bestViews: number;
  /** Resolved rate for the best platform row. */
  rate: ResolvedRate;
  /** Manual per-video override, if any (override wins for this video). */
  override: Decimal | null;
  /** True when ANY platform row of the group is excludeFromEarnings. */
  excluded: boolean;
  /**
   * Posting time of the best row (null for legacy rows without a snapshot).
   * Used only to pick the bonus-tier table deterministically (latest deal).
   */
  postedAt: Date | null;
  /**
   * Stable unique key for this video group's best-platform row (the
   * PlatformPost id, or a stable composite when no linked row exists). The
   * latest-deal vote breaks EXACT `postedAt` ties on this key so every surface
   * that re-derives the aggregate from the same stored rows resolves the SAME
   * deal regardless of row order (F3). Call sites also use it to break
   * equal-view best-platform selection ties, so `postedAt`/`rate`/`dealKey`
   * are all sourced from the SAME deterministically-chosen row.
   */
  dealKey: string;
}

export interface AggregatePayResult {
  /** Count of non-excluded videos. */
  videoCount: number;
  /** Count of non-excluded, non-override videos that cleared min-views. */
  qualifiedVideoCount: number;
  /** Sum of best-platform views across non-excluded videos. */
  totalViews: number;
  /** Sum of per-video base pay (cleared-gate videos only). */
  basePaySum: Decimal;
  /** Sum of manual overrides. */
  overrideSum: Decimal;
  /** Sum of per-video CPM earnings (non-excluded, non-override videos). */
  cpmPay: Decimal;
  /** The ONE aggregate bonus matched on totalViews. */
  bonusPay: Decimal;
  /**
   * basePay reported to clients = basePaySum + overrideSum (override pay rides
   * on the base line, matching PayCycleEntry.basePay). CPM is its OWN line.
   */
  basePay: Decimal;
  /**
   * bonusLane = REPLACE→max(baseSum,bonus) | STACK→baseSum+bonus, then
   * cpmMode ADD    → totalPay = bonusLane + cpm + overrideSum
   * cpmMode REPLACE→ totalPay = max(bonusLane, cpm) + overrideSum.
   */
  totalPay: Decimal;
  /** The deterministically-chosen bonus-tier table for the period. */
  bonusTiers: ViewBonus[];
  /** The bonus mode of the chosen tier table ("REPLACE" | "STACK"). */
  bonusMode: string;
  /** The CPM composition mode of the latest deal ("ADD" | "REPLACE"). */
  cpmMode: string;
  /**
   * The CPM tier-evaluation mode of the latest deal (PER_VIDEO |
   * COMBINED_BRACKETED | COMBINED_FLAT) — the mode actually applied to cpmPay.
   */
  tierEvaluationMode: string;
}

/**
 * Total order over a video's (postedAt, dealKey) for the deterministic
 * latest-deal vote (F3). A DATED row always beats an undated (legacy) one;
 * a later `postedAt` wins; on an EXACT `postedAt` tie the LARGER `dealKey`
 * wins. Returns >0 when (aAt,aKey) ranks strictly AFTER (bAt,bKey), <0 before,
 * 0 equal. Because the order is total and derived only from stored fields, the
 * pay cycle, dashboard, finances, and breakdown surfaces all pick the same
 * latest deal for the same rows, whatever order they iterate.
 */
function compareDeal(
  aAt: Date | null,
  aKey: string,
  bAt: Date | null,
  bKey: string,
): number {
  const aDated = aAt !== null ? 1 : 0;
  const bDated = bAt !== null ? 1 : 0;
  if (aDated !== bDated) return aDated - bDated;
  if (aAt !== null && bAt !== null) {
    const d = aAt.getTime() - bAt.getTime();
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

/**
 * Apply the canonical pay model to a creator's set of video groups. This is the
 * single source of truth shared by the pay-cycle calc and the brand breakdown
 * so the two can never disagree.
 */
export function computeAggregatePay(
  videos: AggregateVideoInput[],
): AggregatePayResult {
  let videoCount = 0;
  let qualifiedVideoCount = 0;
  let totalViews = 0;
  let overrideSum = new Decimal(0);
  let basePaySum = new Decimal(0);
  let cpmSum = new Decimal(0);

  // The cycle's bonus-tier table is snapshotted DETERMINISTICALLY from the
  // chronologically-latest non-excluded video (the "latest deal"). Rows with a
  // null postedAt (legacy, no snapshot) only win when nothing dated has been
  // seen, so any dated deal deterministically beats them. The CPM composition
  // mode rides on the SAME vote — composition happens once at the aggregate
  // level, so it needs ONE deterministic mode exactly like the bonus table.
  let bonusTiers: ViewBonus[] = [];
  let bonusMode = "REPLACE";
  let cpmMode = "ADD";
  // The CPM tier-evaluation mode + the latest deal's CPM SCHEDULE both ride the
  // SAME latest-deal vote as the bonus table: for a COMBINED mode the creator's
  // cumulative views are priced ONCE, and that single pricing needs one
  // deterministic schedule (rate/unit/cap/tiers/floor) exactly like it needs
  // one deterministic mode. `combinedRate` is the voted deal's ResolvedRate.
  let tierEvaluationMode = "PER_VIDEO";
  let combinedRate: ResolvedRate | null = null;
  let bonusTierAt: Date | null = null;
  // dealKey of the current latest-deal winner — the EXACT-timestamp tie-break
  // that makes the vote order-independent (F3).
  let bonusTierKey = "";
  let bonusTierSeen = false;

  // Sum of best-platform views over the videos that feed the CPM lane
  // (non-excluded, non-override, AND whose OWN resolved rate carries a CPM
  // component — see snapshot-eligibility note below). A COMBINED mode walks
  // the tiers on THIS cumulative total.
  let cpmEligibleViews = 0;
  // Snapshot-respecting bonus pool (stack 2, PR #955 verifier finding): the
  // ONE aggregate view bonus is matched on the summed views of videos whose
  // OWN resolved rate has an ACTIVE bonus lane. A video snapshotted WITHOUT
  // bonuses (e.g. posted before the campaign enabled them) must not push the
  // aggregate over a tier threshold — exactly as a video snapshotted without
  // CPM must not feed the combined CPM pool. `totalViews` (display) still
  // counts every non-excluded video. When every video carries the lane the
  // two sums are equal — byte-identical to the historical behavior.
  let bonusEligibleViews = 0;

  for (const video of videos) {
    // An excluded video is paid $0 and its views do NOT count toward the bonus
    // aggregate. Skip it entirely — no count, no views, no pay, no tier vote.
    if (video.excluded) continue;

    videoCount += 1;
    totalViews += video.bestViews;
    if (video.rate.viewBonuses.length > 0) {
      bonusEligibleViews += video.bestViews;
    }

    // `?? null`: a row shape minted without postedAt (narrow select /
    // test fixture) must behave like null, not crash getTime(). The vote is a
    // deterministic total order over (postedAt, dealKey) — equal timestamps
    // (and even multiple undated legacy rows) resolve to the SAME winner on
    // every surface, independent of iteration order (F3).
    const at = video.postedAt ?? null;
    const winsVote =
      !bonusTierSeen ||
      compareDeal(at, video.dealKey, bonusTierAt, bonusTierKey) > 0;
    if (winsVote) {
      bonusTiers = video.rate.viewBonuses;
      bonusMode = video.rate.viewBonusMode;
      cpmMode = video.rate.cpmMode ?? "ADD";
      tierEvaluationMode = video.rate.tierEvaluationMode ?? "PER_VIDEO";
      combinedRate = video.rate;
      bonusTierAt = at;
      bonusTierKey = video.dealKey;
      bonusTierSeen = true;
    }

    // A manual override sets this video's pay; its views still aggregate.
    // No base pay AND no CPM on an overridden video — the override IS its pay.
    if (video.override !== null) {
      overrideSum = overrideSum.plus(video.override);
      continue;
    }

    if (video.bestViews >= video.rate.basePayMinViews) {
      qualifiedVideoCount += 1;
      basePaySum = basePaySum.plus(video.rate.paymentPerVideo);
    }

    // CPM is per-video on best-platform views — NOT gated by the BASE-pay
    // min-views (it already scales with views; its own cpmMinViews floor is
    // applied inside the schedule) and NEVER part of the bonus REPLACE
    // comparison. Under a COMBINED mode this per-video sum is DISCARDED below
    // and recomputed once on the cumulative total — but we still accumulate it
    // (PER_VIDEO keeps it).
    cpmSum = cpmSum.plus(cpmPayForRate(video.bestViews, video.rate));
    // Snapshot eligibility (stack 2, PR #955 verifier finding): only videos
    // whose OWN resolved rate carries a CPM component (a positive rate or a
    // tier schedule) feed the cumulative COMBINED pool. Before this, enabling
    // CPM mid-period retroactively priced OLD videos' views — snapshotted
    // WITHOUT CPM — through the new schedule (increase-only; the brand
    // overpaid). PER_VIDEO already respected the snapshot (cpmPayForRate on a
    // CPM-less rate is $0), so this only changes COMBINED modes.
    if (
      (video.rate.cpmRatePerUnit ?? 0) > 0 ||
      video.rate.cpmTiers.length > 0
    ) {
      cpmEligibleViews += video.bestViews;
    }
  }

  // COMBINED tier modes reprice the CPM lane on the creator's CUMULATIVE period
  // views instead of per video (the marginal-bracket or retroactive-flat calc
  // in lib/pay-cpm.ts), using the latest deal's voted schedule — mirroring how
  // the bonus table + cpmMode are chosen from the latest deal. PER_VIDEO (the
  // default) leaves the per-video sum above byte-identical. `combinedRate` is
  // null only when NO video voted (no non-excluded videos), in which case
  // cpmEligibleViews is 0 and the CPM lane is $0 regardless.
  if (isCombinedTierMode(tierEvaluationMode) && combinedRate !== null) {
    cpmSum = computeCombinedCpmPay(
      cpmEligibleViews,
      {
        ratePerUnit: combinedRate.cpmRatePerUnit,
        viewUnit: combinedRate.cpmViewUnit,
        capViews: combinedRate.cpmCapViews,
        tiers: combinedRate.cpmTiers,
        minViews: combinedRate.cpmMinViews ?? null,
      },
      tierEvaluationMode,
    );
  }

  // ONE aggregate bonus matched on the summed views of the BONUS-ELIGIBLE
  // videos (those whose own resolved rate has an active bonus lane — see the
  // snapshot-eligibility note above). Equal to totalViews whenever every
  // video carries the lane (the historical case).
  let bonusPay = new Decimal(0);
  const sortedBonuses = [...bonusTiers].sort((a, b) => b.views - a.views);
  for (const tier of sortedBonuses) {
    if (bonusEligibleViews >= tier.views) {
      bonusPay = new Decimal(tier.bonus);
      break;
    }
  }

  // Bonus REPLACE replaces BASE PAY ONLY — the max() is strictly
  // base-vs-bonus; CPM is never part of THIS comparison.
  const baseAndBonus =
    bonusMode === "REPLACE"
      ? Decimal.max(basePaySum, bonusPay)
      : basePaySum.plus(bonusPay);

  // CPM composition (see module docstring): ADD = today's behavior, CPM
  // rides on top; REPLACE = the creator earns the BETTER of the bonus lane
  // or the CPM lane (max() — monotone, mirrors viewBonusMode REPLACE).
  // Overrides ride on top in both modes (an override IS that video's pay).
  const composed =
    cpmMode === "REPLACE"
      ? Decimal.max(baseAndBonus, cpmSum)
      : baseAndBonus.plus(cpmSum);

  return {
    videoCount,
    qualifiedVideoCount,
    totalViews,
    basePaySum,
    overrideSum,
    cpmPay: cpmSum,
    bonusPay,
    basePay: basePaySum.plus(overrideSum),
    totalPay: composed.plus(overrideSum),
    bonusTiers,
    bonusMode,
    cpmMode,
    tierEvaluationMode,
  };
}
