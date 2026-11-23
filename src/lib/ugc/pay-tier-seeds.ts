/**
 * Default view-bonus tier seeds for the deal pay editor (ported from Ripple
 * lib/pay-tier-seeds.ts). When a deal has NO tiers yet, the editor pre-seeds
 * these five thresholds so the owner only types the amounts. Rows left at a
 * $0 bonus are dropped on save, so an untouched seed never persists.
 */

export interface SeedViewBonusTier {
  views: number;
  bonus: number;
}

export const DEFAULT_VIEW_BONUS_TIER_SEEDS: readonly SeedViewBonusTier[] = [
  { views: 10_000, bonus: 0 },
  { views: 50_000, bonus: 0 },
  { views: 100_000, bonus: 0 },
  { views: 500_000, bonus: 0 },
  { views: 1_000_000, bonus: 0 },
];

/** Fresh, mutable copies of the seed rows (never hand out the constant). */
export function seedViewBonusTiers(): SeedViewBonusTier[] {
  return DEFAULT_VIEW_BONUS_TIER_SEEDS.map((tier) => ({ ...tier }));
}
