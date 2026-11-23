/**
 * Tests for lib/campaign-earnings — creator pay calculation.
 *
 * Regression guard for the "video cards don't show YouTube views" fix: a
 * YouTube platform member must count toward earnings exactly like Instagram
 * and TikTok. Tier matching uses the best single-platform total, not the
 * cross-platform aggregate.
 */
import { describe, it, expect } from "vitest";
import {
  calcPay,
  composeCampaignTotal,
  viewsByPlatform,
  type ViewBonusTier,
} from "@/lib/ugc/campaign-earnings";

const tiers: ViewBonusTier[] = [
  { views: 1_000, bonus: 10 },
  { views: 10_000, bonus: 50 },
  { views: 100_000, bonus: 200 },
];

describe("viewsByPlatform", () => {
  it("sums views per platform across all members, including YouTube", () => {
    const result = viewsByPlatform([
      { platform: "INSTAGRAM", viewCount: 11_100 },
      { platform: "TIKTOK", viewCount: 823 },
      { platform: "YOUTUBE", viewCount: 5_000 },
    ]);

    expect(result).toEqual({ INSTAGRAM: 11_100, TIKTOK: 823, YOUTUBE: 5_000 });
  });

  it("upper-cases platform keys so casing differences don't split a bucket", () => {
    const result = viewsByPlatform([
      { platform: "youtube", viewCount: 100 },
      { platform: "YOUTUBE", viewCount: 200 },
    ]);

    expect(result).toEqual({ YOUTUBE: 300 });
  });

  it("returns an empty object for a video with no posts", () => {
    expect(viewsByPlatform([])).toEqual({});
  });
});

describe("calcPay", () => {
  it("returns base pay with no tier when views are below all tiers", () => {
    const { pay, tier } = calcPay([500], 25, tiers);
    expect(pay).toBe(25);
    expect(tier).toBeNull();
  });

  it("selects a tier when a YouTube member is the highest-view platform", () => {
    // Instagram + TikTok are tiny; YouTube carries the video.
    const perPlatform = Object.values(
      viewsByPlatform([
        { platform: "INSTAGRAM", viewCount: 800 },
        { platform: "TIKTOK", viewCount: 400 },
        { platform: "YOUTUBE", viewCount: 120_000 },
      ]),
    );
    const { pay, tier } = calcPay(perPlatform, 25, tiers);
    // 120k YouTube views → top tier (REPLACE mode → max(base, bonus)).
    expect(tier?.views).toBe(100_000);
    expect(pay).toBe(200);
  });

  it("lets a YouTube member cross basePayMinViews to unlock base pay", () => {
    // Without YouTube, no platform meets the 5k minimum → base pay is 0.
    const withoutYt = calcPay([800, 400], 25, [], "REPLACE", 5_000);
    expect(withoutYt.pay).toBe(0);

    // With a YouTube member above the minimum, base pay is unlocked.
    const perPlatform = Object.values(
      viewsByPlatform([
        { platform: "INSTAGRAM", viewCount: 800 },
        { platform: "TIKTOK", viewCount: 400 },
        { platform: "YOUTUBE", viewCount: 6_000 },
      ]),
    );
    const withYt = calcPay(perPlatform, 25, [], "REPLACE", 5_000);
    expect(withYt.pay).toBe(25);
  });

  it("tier-matches on the best single platform, not the aggregate", () => {
    // Aggregate is 12k, but no single platform reaches the 10k tier.
    const perPlatform = Object.values(
      viewsByPlatform([
        { platform: "INSTAGRAM", viewCount: 4_000 },
        { platform: "TIKTOK", viewCount: 4_000 },
        { platform: "YOUTUBE", viewCount: 4_000 },
      ]),
    );
    const { tier } = calcPay(perPlatform, 25, tiers);
    // Best single platform is 4k → only the 1k tier matches, not 10k.
    expect(tier?.views).toBe(1_000);
  });

  it("adds the bonus on top of base pay in ADD mode", () => {
    const { pay, tier } = calcPay([15_000], 25, tiers, "ADD");
    expect(tier?.views).toBe(10_000);
    expect(pay).toBe(25 + 50);
  });

  it("handles an empty perPlatformViews array without throwing", () => {
    const { pay, tier } = calcPay([], 25, tiers);
    expect(pay).toBe(25);
    expect(tier).toBeNull();
  });
});

// ── Campaign-total composition (Bugbot, PR #341) ────────────────────────────
//
// REPLACE is non-additive: summing per-video composed pay overstates the
// campaign total whenever some videos are base-dominant and others
// CPM-dominant. composeCampaignTotal sums the RAW lanes (exposed on calcPay's
// return) and composes the cpmMode ONCE — matching computeAggregatePay.

describe("calcPay · raw lanes + composeCampaignTotal", () => {
  const cpm = {
    cpmRate: 10,
    cpmViewUnit: 1000,
    cpmCapViews: null,
    cpmTiers: [],
    cpmMode: "REPLACE",
    cpmMinViews: null,
  };

  it("exposes the RAW lanes even when REPLACE zeroes the losing lane's contribution", () => {
    const r = calcPay([10_000], 25, [], "REPLACE", 0, cpm);
    // Composed: cpm wins (100 > 25) → pay 100, cpmPay contribution 100.
    expect(r.pay).toBe(100);
    expect(r.cpmPay).toBe(100);
    // Raw lanes keep BOTH values uncomposed.
    expect(r.lanes).toEqual({ baseBonus: 25, cpm: 100 });
  });

  it("REPLACE total is max(baseSum, cpmSum), not the sum of per-video maxes", () => {
    // video A: 100 views → base 25, cpm 1 (base-dominant)
    // video B: 10k views → base 25, cpm 100 (cpm-dominant)
    const rows = [
      calcPay([100], 25, [], "REPLACE", 0, cpm),
      calcPay([10_000], 25, [], "REPLACE", 0, cpm),
    ];
    // Per-video composed sum would be 25 + 100 = 125; canonical is
    // max(50, 101) = 101.
    expect(rows.reduce((s, r) => s + r.pay, 0)).toBe(125);
    expect(composeCampaignTotal(rows, "REPLACE")).toBe(101);
  });

  it("ADD mode reduces to the plain sum (composition-order invariant)", () => {
    const addCpm = { ...cpm, cpmMode: "ADD" };
    const rows = [
      calcPay([100], 25, [], "REPLACE", 0, addCpm),
      calcPay([10_000], 25, [], "REPLACE", 0, addCpm),
    ];
    expect(composeCampaignTotal(rows, "ADD")).toBe(151);
    expect(composeCampaignTotal(rows, "ADD")).toBe(
      rows.reduce((s, r) => s + r.pay, 0),
    );
  });

  it("no cpm config → lanes carry base+bonus only and the total is the sum", () => {
    const rows = [calcPay([15_000], 25, tiers, "ADD"), calcPay([100], 25, tiers)];
    expect(rows[0].lanes).toEqual({ baseBonus: 75, cpm: 0 });
    expect(composeCampaignTotal(rows, null)).toBe(75 + 25);
  });
});
