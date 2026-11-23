/**
 * Pay-schedule guards (ported from Ripple lib/pay-validation.ts). The deal
 * schemas in schemas.ts use them, so every deal write (page or Hydra Agent)
 * passes the same checks:
 *
 *   1. DUPLICATE views thresholds in cpmTiers / viewBonuses. The pay math sorts
 *      a table by threshold and picks ONE entry per bracket, so two entries at
 *      the same threshold pay ORDER-DEPENDENTLY. Reject instead.
 *   2. Non-finite / absurd magnitudes (JSON.parse("1e999") → Infinity). Money
 *      rates cap at $1M; view thresholds at 1e9.
 */

/** Max money rate accepted on any pay field ($/video, $/unit, bonus $). */
export const MAX_PAY_RATE = 1_000_000;

/** Max views accepted on any threshold/unit/cap field. */
export const MAX_PAY_VIEWS = 1_000_000_000;

export const DUPLICATE_VIEWS_MESSAGE =
  "Duplicate views thresholds are not allowed";

/**
 * zod .refine() guard: every entry's views threshold must be unique within
 * the table. Works for both CpmTier[] and ViewBonus[] shapes.
 */
export function hasUniqueViewThresholds(
  rows: ReadonlyArray<{ views: number }>,
): boolean {
  return new Set(rows.map((r) => r.views)).size === rows.length;
}

// ─── Bonus lanes: view bonuses AND CPM may be combined ───────────────────────
//
// Owner directive 2026-07-22: a pay structure may activate view bonuses, CPM,
// BOTH, or neither on top of base pay ("mix and match"). The former
// edit-boundary exclusivity gate (view bonuses XOR CPM) is REMOVED — the
// aggregate engine (lib/pay-aggregate computeAggregatePay) always computed a
// both-active structure (legacy rows), composing as:
//   bonusLane = viewBonusMode REPLACE→max(base,bonus) | ADD→base+bonus
//   total     = cpmMode      REPLACE→max(bonusLane,cpm) | ADD→bonusLane+cpm
// A lane is active when its config is present (viewBonuses non-empty; a
// positive cpmRate or non-empty cpmTiers) — presence IS the flag; there is
// deliberately no separate enable column the engine would have to reconcile.

/** True when a viewBonuses table has at least one tier (the lane is active). */
export function hasActiveViewBonuses(
  viewBonuses: ReadonlyArray<unknown> | null | undefined,
): boolean {
  return Array.isArray(viewBonuses) && viewBonuses.length > 0;
}

/**
 * True when the CPM lane is active: a positive flat rate OR at least one
 * tier. Mirrors lib/pay-cpm hasCpmComponent's "any paying component" idea,
 * shape-loose so it accepts plain numbers, Decimals or zod outputs.
 */
export function hasActiveCpm(fields: {
  cpmRate: number | { toNumber(): number } | null | undefined;
  cpmTiers: ReadonlyArray<unknown> | null | undefined;
}): boolean {
  const rate =
    typeof fields.cpmRate === "object" && fields.cpmRate !== null
      ? fields.cpmRate.toNumber()
      : (fields.cpmRate ?? null);
  if (rate !== null && Number.isFinite(rate) && rate > 0) return true;
  return Array.isArray(fields.cpmTiers) && fields.cpmTiers.length > 0;
}

// ─── COMBINED_FLAT monotonic-rate guard ──────────────────────────────────────
//
// COMBINED_FLAT reprices EVERY view at the highest CROSSED tier's rate. If a
// higher-threshold tier carries a LOWER rate than the base rate (or a lower
// tier), crossing that threshold slashes total pay — a $1,500 cliff on a single
// extra view (base $5/1k cap 400k, tier $1/1k at 500k: 500,000 views → $2,000;
// 500,001 → $500). Marginal brackets (PER_VIDEO / COMBINED_BRACKETED) never
// invert like this, so this guard applies ONLY to COMBINED_FLAT. Enforced at
// the EDIT boundary on the RESULTING pay structure (payload merged over the
// current row) by every route that writes pay structure.

/** 400 message when a COMBINED_FLAT schedule has a downward rate step. */
export const FLAT_DECREASING_RATE_MESSAGE =
  "'Combined: flat' requires non-decreasing CPM rates: each tier's rate must be at least the base rate and every lower tier's rate. A lower rate at a higher threshold would cut total pay when a creator crosses it.";

function toRateNumber(
  rate: number | { toNumber(): number } | null | undefined,
): number {
  if (rate === null || rate === undefined) return 0;
  const n = typeof rate === "object" ? rate.toNumber() : rate;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * True when a COMBINED_FLAT schedule's rates are NOT non-decreasing by
 * threshold — i.e. the base rate, then each tier's rate in ascending-threshold
 * order, ever steps DOWN. The base rate is the floor of the whole schedule.
 * Only meaningful for COMBINED_FLAT; callers gate on the resulting mode.
 */
export function violatesFlatMonotonicRates(fields: {
  cpmRate: number | { toNumber(): number } | null | undefined;
  cpmTiers:
    | ReadonlyArray<{ views: number; ratePerUnit: number }>
    | ReadonlyArray<unknown>
    | null
    | undefined;
}): boolean {
  const tiers = Array.isArray(fields.cpmTiers)
    ? (fields.cpmTiers as ReadonlyArray<{ views: number; ratePerUnit: number }>)
    : [];
  if (tiers.length === 0) return false; // no tier to cross → no cliff

  const sorted = [...tiers].sort((a, b) => a.views - b.views);
  let prev = toRateNumber(fields.cpmRate); // base rate = floor of the schedule
  for (const tier of sorted) {
    const rate = toRateNumber(tier.ratePerUnit);
    if (rate < prev) return true; // a downward step → cliff
    prev = rate;
  }
  return false;
}
