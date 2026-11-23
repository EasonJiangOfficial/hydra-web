/**
 * CPM payment component — piecewise per-view-unit rate math.
 *
 * Ported from Ripple lib/pay-cpm.ts (Prisma.Decimal → decimal.js; math unchanged).
 * A UGC deal can pay per view block ("$2 per 1,000 views"), optionally capped,
 * optionally with a marginal tier schedule above thresholds. Every Hydra pay
 * path calls {@link computeCpmPay} so the numbers can never diverge.
 *
 * ── Exact semantics (pinned by __tests__/pay-cpm.test.ts) ──────────────────
 *
 * A schedule is { ratePerUnit, viewUnit, capViews, tiers, minViews } where
 * tiers is an ascending [{views, ratePerUnit}] list. Earnings are MARGINAL
 * (piecewise): each view falls into exactly one segment and pays that
 * segment's rate.
 *
 *   - Base segment [0, B) pays `ratePerUnit` per `viewUnit` views, where
 *     B = min(capViews, firstTier.views) when both exist, else whichever is
 *     set, else unbounded.
 *   - Tier i covers [tier_i.views, tier_{i+1}.views) (last tier unbounded)
 *     and pays tier_i.ratePerUnit per viewUnit views. Tiers pay ABOVE the
 *     cap by design — the cap only bounds the base-rate segment when tiers
 *     are present.
 *   - With a cap and NO tiers, views beyond the cap pay nothing.
 *   - A gap between the cap and the first tier threshold pays nothing.
 *   - capViews <= 0 (or null) = uncapped. An override row uses capViews = 0
 *     to mean "explicitly uncapped" (distinct from null = inherit).
 *   - minViews is the FLOOR where CPM starts counting: views below it pay
 *     nothing in any segment, so the base segment effectively becomes
 *     [floor, B). Cap and tier THRESHOLDS keep their absolute meaning (a
 *     tier at 500k is still at 500k views — the floor only removes the paid
 *     views below it). A floor at/above a segment's end simply zeroes that
 *     segment (never negative); null/undefined/<= 0 = today's behavior
 *     (counts from view zero).
 *
 * Floor example — $2/1000 starting after 10,000 views:
 *   8,000 views → $0; 10,000 views → $0; 15,000 views → 5,000×$2/1k = $10.
 *
 * Example — $2/1000 up to 500k, then $1.50/1000 to 1M, then $1/1000:
 *   750,000 views → 500k×$2/1k + 250k×$1.50/1k = $1,000 + $375 = $1,375.
 *
 * ── Money correctness ───────────────────────────────────────────────────────
 *
 * All arithmetic is Decimal — `views × rate ÷ unit` in binary floats drifts
 * (e.g. $2 × 333,333 / 1000). Segments accumulate at full Decimal precision;
 * the FINAL per-video amount is rounded to whole cents (2dp, half-up), so it
 * converts to the integer-cents columns without loss.
 *
 * Inputs are defensive: a non-finite/zero/negative viewUnit falls back to
 * 1000, malformed tiers are dropped, and negative views pay $0 — this module
 * must never throw or return NaN for data that slipped past API validation
 * (e.g. legacy JSON snapshots).
 */
import Decimal from "decimal.js";

/** One marginal tier: views at/above `views` pay `ratePerUnit` per unit. */
export interface CpmTier {
  views: number;
  ratePerUnit: number;
}

/** A fully-resolved CPM schedule (plain numbers, post-Decimal-collapse). */
export interface CpmSchedule {
  /** $ per `viewUnit` views for the base segment. null/0 = no flat rate. */
  ratePerUnit: number | null;
  /** The view block one ratePerUnit buys (default 1000 = "per mille"). */
  viewUnit: number;
  /** Base-segment cap — see module docstring. null / <= 0 = uncapped. */
  capViews: number | null;
  /** Ascending marginal tiers above their thresholds. null/[] = none. */
  tiers: CpmTier[] | null;
  /**
   * Floor where CPM starts counting — views below it pay nothing in the CPM
   * lane (see module docstring). OPTIONAL so legacy schedule shapes (old JSON
   * snapshots, pre-floor callers) keep compiling and behave exactly as
   * before: absent/null/<= 0 = counts from view zero.
   */
  minViews?: number | null;
}

const DEFAULT_VIEW_UNIT = 1000;

/** True when the schedule has any paying component (flat rate or tiers). */
export function hasCpmComponent(schedule: {
  ratePerUnit: number | null;
  tiers: CpmTier[] | null;
}): boolean {
  if (schedule.ratePerUnit !== null && schedule.ratePerUnit > 0) return true;
  return sanitizeCpmTiers(schedule.tiers).length > 0;
}

/**
 * Drop malformed tiers (non-finite, threshold <= 0, negative rate) and sort
 * ascending by threshold so the piecewise walk below is well-defined even
 * when a legacy JSON snapshot stored tiers out of order.
 */
export function sanitizeCpmTiers(tiers: CpmTier[] | null | undefined): CpmTier[] {
  if (!Array.isArray(tiers)) return [];
  return tiers
    .filter(
      (t) =>
        t !== null &&
        typeof t === "object" &&
        Number.isFinite(t.views) &&
        t.views > 0 &&
        Number.isFinite(t.ratePerUnit) &&
        t.ratePerUnit >= 0,
    )
    .map((t) => ({ views: Math.floor(t.views), ratePerUnit: t.ratePerUnit }))
    .sort((a, b) => a.views - b.views);
}

/**
 * Compute the CPM earnings for ONE video's views against a schedule.
 *
 * Returns a Decimal rounded to whole cents (never NaN/negative).
 * See the module docstring for the exact piecewise semantics.
 */
export function computeCpmPay(
  views: number,
  schedule: CpmSchedule,
): Decimal {
  const zero = new Decimal(0);
  if (!Number.isFinite(views) || views <= 0) return zero;

  const unit =
    Number.isFinite(schedule.viewUnit) && schedule.viewUnit > 0
      ? schedule.viewUnit
      : DEFAULT_VIEW_UNIT;
  const baseRate =
    schedule.ratePerUnit !== null &&
    Number.isFinite(schedule.ratePerUnit) &&
    schedule.ratePerUnit > 0
      ? schedule.ratePerUnit
      : 0;
  const tiers = sanitizeCpmTiers(schedule.tiers);
  const cap =
    schedule.capViews !== null &&
    Number.isFinite(schedule.capViews) &&
    schedule.capViews! > 0
      ? Math.floor(schedule.capViews!)
      : null;

  if (baseRate <= 0 && tiers.length === 0) return zero;

  // Starting floor: views below it pay nothing in ANY segment. Defensive —
  // a negative / non-finite / absent floor is treated as 0 (today's
  // counts-from-zero behavior; this function never throws on legacy data).
  const floor =
    schedule.minViews !== null &&
    schedule.minViews !== undefined &&
    Number.isFinite(schedule.minViews) &&
    schedule.minViews > 0
      ? Math.floor(schedule.minViews)
      : 0;

  // Base segment [0, B): the flat rate runs until the cap or the first tier
  // threshold, whichever comes first (tiers take over at their threshold
  // even if the cap is higher — the cap can only SHORTEN the base segment).
  const firstTierAt = tiers.length > 0 ? tiers[0].views : null;
  let baseEnd = Number.POSITIVE_INFINITY;
  if (cap !== null) baseEnd = cap;
  if (firstTierAt !== null) baseEnd = Math.min(baseEnd, firstTierAt);

  let total = zero;

  // new Decimal(number) parses the number's shortest decimal
  // representation ("0.1" stays exactly 0.1) — no binary-float drift.
  // The floor clips the segment from BELOW (the paid range is
  // [floor, min(views, baseEnd))) — a floor at/above baseEnd zeroes the
  // segment, never goes negative.
  const baseViews = Math.min(views, baseEnd) - floor;
  if (baseRate > 0 && baseViews > 0) {
    total = total.plus(
      new Decimal(baseRate).times(baseViews).div(unit),
    );
  }

  // Marginal tier segments: [tier_i.views, tier_{i+1}.views) — the last tier
  // is unbounded. Views between the cap and the first tier threshold (when
  // cap < firstTierAt) fall in NO segment and pay nothing. The floor clips
  // each segment from below too (thresholds stay ABSOLUTE — a floor between
  // tiers only removes the paid views under it).
  for (let i = 0; i < tiers.length; i++) {
    const segStart = Math.max(tiers[i].views, floor);
    const segEnd = i + 1 < tiers.length ? tiers[i + 1].views : Number.POSITIVE_INFINITY;
    const segViews = Math.min(views, segEnd) - segStart;
    if (segViews <= 0) continue;
    if (tiers[i].ratePerUnit <= 0) continue;
    total = total.plus(
      new Decimal(tiers[i].ratePerUnit).times(segViews).div(unit),
    );
  }

  // Payable amounts are whole cents (Decimal(12,2) money columns) — round
  // ONCE per video, half-up, after full-precision accumulation.
  return total.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * How a schedule's rate TIERS are evaluated across a creator's period videos.
 * See pay-aggregate.ts computeAggregatePay for where the mode is applied.
 *
 *   PER_VIDEO          — each video's OWN views walk the tiers (today's
 *                        behavior). NOT handled here: the caller sums
 *                        {@link computeCpmPay} per video.
 *   COMBINED_BRACKETED — the CUMULATIVE period views walk the tiers MARGINALLY
 *                        (identical to running {@link computeCpmPay} on the
 *                        summed views): the low rate on the first
 *                        threshold-worth of views, the higher rate above.
 *   COMBINED_FLAT      — once cumulative views CROSS a tier threshold, ALL
 *                        views pay that tier's rate (retroactive).
 */
export type TierEvaluationMode =
  | "PER_VIDEO"
  | "COMBINED_BRACKETED"
  | "COMBINED_FLAT";

/** True for the two modes that price on the creator's CUMULATIVE period views. */
export function isCombinedTierMode(
  mode: string | null | undefined,
): mode is "COMBINED_BRACKETED" | "COMBINED_FLAT" {
  return mode === "COMBINED_BRACKETED" || mode === "COMBINED_FLAT";
}

/**
 * CPM earnings on a creator's CUMULATIVE period views under a COMBINED tier
 * mode. `totalViews` is the SUM of best-platform views across the videos that
 * feed the CPM lane (non-excluded, non-override) — exactly the set the
 * per-video path would have priced individually.
 *
 *   COMBINED_BRACKETED → the marginal walk in {@link computeCpmPay}, run once
 *     on the cumulative total. Views up to the first threshold pay the base
 *     rate; each higher bracket pays its tier rate on the views inside it.
 *   COMBINED_FLAT → find the HIGHEST tier the cumulative total has CROSSED
 *     (strictly: `totalViews > tier.views`, so exactly-at-threshold has NOT
 *     crossed — mirroring the marginal walk, where a tier's segment is empty
 *     at exactly its threshold), then price ALL views at that tier's rate. If
 *     no tier is crossed, the result is the plain base/cap calc (identical to
 *     the marginal walk when no tier engages).
 *
 * Returns a whole-cent Decimal; never NaN/negative. The schedule's minViews
 * floor and viewUnit are honored via {@link computeCpmPay}. The FLAT branch
 * deliberately drops the cap once a tier is crossed (tiers pay ABOVE the cap
 * by design in this model — see the module docstring).
 */
export function computeCombinedCpmPay(
  totalViews: number,
  schedule: CpmSchedule,
  mode: "COMBINED_BRACKETED" | "COMBINED_FLAT",
): Decimal {
  if (mode === "COMBINED_BRACKETED") {
    // The marginal walk already IS the bracketed calc — just run it on the
    // cumulative total instead of per video.
    return computeCpmPay(totalViews, schedule);
  }

  // COMBINED_FLAT: the highest CROSSED tier reprices every view.
  const tiers = sanitizeCpmTiers(schedule.tiers);
  let crossedRate: number | null = null;
  for (const tier of tiers) {
    if (totalViews > tier.views) crossedRate = tier.ratePerUnit;
  }
  if (crossedRate === null) {
    // No tier crossed → identical to the marginal walk (base + cap, no tier
    // engaged). Reusing computeCpmPay keeps floor/cap/rounding behavior exact.
    return computeCpmPay(totalViews, schedule);
  }
  // A tier is crossed → ALL views (above the floor) pay that tier's rate. Cap
  // is dropped and tiers cleared so the flat rate applies to the whole span.
  return computeCpmPay(totalViews, {
    ratePerUnit: crossedRate,
    viewUnit: schedule.viewUnit,
    capViews: null,
    tiers: null,
    minViews: schedule.minViews ?? null,
  });
}

/**
 * Attribute a COMBINED-mode CPM TOTAL back across the videos that fed the
 * cumulative walk, so per-video DISPLAY rows sum EXACTLY to the total. Each
 * video gets a share of `total` proportional to its best-platform view count;
 * the sub-cent remainder is distributed by LARGEST fractional remainder (ties →
 * larger views, then lower index) so the returned parts sum to `total` to the
 * exact CENT — never ±1¢ drift.
 *
 * `views` are the eligible (non-excluded, non-override) best-platform view
 * counts, in a STABLE order the caller maps back to its rows. Returns one
 * whole-cent Decimal per input, same length/order. A 0-view video gets $0; an
 * empty input, a non-positive total, or all-zero views returns all-$0.
 *
 * Pure — no per-video CPM recompute; the marginal/flat math already produced
 * `total` (see {@link computeCombinedCpmPay}). This is DISPLAY attribution only:
 * the money PAID is the single `total`.
 */
export function distributeCombinedCpm(
  views: number[],
  total: Decimal,
): Decimal[] {
  const n = views.length;
  if (n === 0) return [];
  const zero = () => new Decimal(0);

  // Normalize inputs: only finite, strictly-positive view counts get a share;
  // non-finite (Infinity/NaN), negative, or zero views are treated as a $0
  // share (never NaN). The sum-to-`total`-to-the-exact-cent invariant holds for
  // any input WITH at least one positive view — the CAVEAT is the degenerate
  // case where every view normalizes to 0 (all-zero / all non-finite) while
  // total > 0: with no positive view to attribute against, the function returns
  // all-$0 (see the sumViews <= 0 guard below), which sums to 0, NOT `total`.
  // The parts never OVER-sum and never go NaN (defensive; F7).
  const safe = views.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));

  // Work in whole cents: `total` is already a whole-cent amount (2dp). A
  // non-finite total (defensive) yields all $0 rather than NaN.
  const totalCents = Math.round(total.toNumber() * 100);
  const sumViews = safe.reduce((a, v) => a + v, 0);
  if (!Number.isFinite(totalCents) || totalCents <= 0 || sumViews <= 0)
    return views.map(zero);

  const totalCentsD = new Decimal(totalCents);
  const sumD = new Decimal(sumViews);
  // Exact per-video cents (Decimal division avoids float overflow when
  // views × totalCents exceeds Number.MAX_SAFE_INTEGER).
  const exact = safe.map((v) =>
    v > 0 ? totalCentsD.times(v).div(sumD) : zero(),
  );
  const floors = exact.map((x) => x.floor());
  const used = floors.reduce((a, x) => a + x.toNumber(), 0);
  let remainder = totalCents - used; // integer in [0, n)

  // Largest fractional remainder first; deterministic tie-break.
  const order = exact
    .map((x, i) => ({
      i,
      frac: x.minus(x.floor()).toNumber(),
      views: safe[i],
    }))
    .sort((a, b) => b.frac - a.frac || b.views - a.views || a.i - b.i);

  const cents = floors.map((x) => x.toNumber());
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
    cents[order[k].i] += 1;
  }
  return cents.map((c) => new Decimal(c).div(100));
}
