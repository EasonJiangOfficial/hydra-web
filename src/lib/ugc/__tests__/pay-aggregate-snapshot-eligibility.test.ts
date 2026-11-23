/**
 * Snapshot-respecting lane eligibility in computeAggregatePay (stack 2,
 * verifier finding on PR #955).
 *
 * A COMBINED tier-evaluation mode prices the CPM lane on the creator's
 * CUMULATIVE period views — but the cumulative pool must only contain views
 * from videos whose RESOLVED rate actually carries a CPM component. Before
 * this fix, enabling CPM mid-period retroactively priced OLD videos' views
 * (snapshotted WITHOUT CPM) through the new schedule: bonuses-only-snapshot
 * video with 100k views + a new 10k CPM video under COMBINED_BRACKETED $2/1k
 * paid $220 CPM instead of $20 (increase-only — the brand overpays).
 *
 * The SAME snapshot rule applies to the view-bonus lane: the ONE aggregate
 * bonus is matched on the summed views of videos whose resolved rate has an
 * ACTIVE bonus lane — a video snapshotted without bonuses must not push the
 * aggregate over a tier threshold.
 *
 * Byte-identical pin: when EVERY video's resolved rate carries the lane, the
 * numbers are exactly what today's math produces.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  computeAggregatePay,
  type AggregateVideoInput,
  type ResolvedRate,
} from "@/lib/ugc/pay-aggregate";

function rate(overrides: Partial<ResolvedRate> = {}): ResolvedRate {
  return {
    paymentPerVideo: 0,
    basePayMinViews: 0,
    viewBonuses: [],
    viewBonusMode: "REPLACE",
    cpmRatePerUnit: null,
    cpmViewUnit: 1000,
    cpmCapViews: null,
    cpmTiers: [],
    cpmMode: "ADD",
    cpmMinViews: null,
    tierEvaluationMode: "PER_VIDEO",
    ...overrides,
  };
}

function video(
  bestViews: number,
  r: ResolvedRate,
  postedAt: Date,
  dealKey: string,
): AggregateVideoInput {
  return { bestViews, rate: r, override: null, excluded: false, postedAt, dealKey };
}

const BONUS_50K = [{ views: 50_000, bonus: 50 }];

describe("computeAggregatePay — CPM lane snapshot eligibility (COMBINED modes)", () => {
  it("verifier repro: a bonuses-only-snapshot 100k video does NOT feed the combined CPM pool ($20, not $220)", () => {
    // OLD video: snapshotted BEFORE the campaign had CPM — bonuses only.
    const oldVideo = video(
      100_000,
      rate({ viewBonuses: BONUS_50K }),
      new Date("2026-06-01"),
      "a-old",
    );
    // NEW video: snapshotted AFTER CPM was added — carries the CPM schedule
    // and the COMBINED mode; latest deal, so its snapshot wins the vote.
    const newVideo = video(
      10_000,
      rate({
        viewBonuses: BONUS_50K,
        cpmRatePerUnit: 2,
        tierEvaluationMode: "COMBINED_BRACKETED",
      }),
      new Date("2026-07-01"),
      "b-new",
    );

    const agg = computeAggregatePay([oldVideo, newVideo]);

    // CPM pool = ONLY the CPM-carrying video's 10k views → $2/1k = $20.
    expect(agg.cpmPay.toNumber()).toBe(20);
    // The bonus lane is untouched: both snapshots carry the bonus table, so
    // the aggregate still matches on 110k → $50 (REPLACE over $0 base).
    expect(agg.bonusPay.toNumber()).toBe(50);
    expect(agg.totalPay.toNumber()).toBe(70);
    // Display totals still count every non-excluded video's views.
    expect(agg.totalViews).toBe(110_000);
  });

  it("byte-identical pin: when EVERY video's snapshot carries CPM, the combined pool is unchanged ($220)", () => {
    const both = (views: number, at: string, key: string) =>
      video(
        views,
        rate({
          viewBonuses: BONUS_50K,
          cpmRatePerUnit: 2,
          tierEvaluationMode: "COMBINED_BRACKETED",
        }),
        new Date(at),
        key,
      );

    const agg = computeAggregatePay([
      both(100_000, "2026-06-01", "a"),
      both(10_000, "2026-07-01", "b"),
    ]);

    expect(agg.cpmPay.toNumber()).toBe(220);
    expect(agg.bonusPay.toNumber()).toBe(50);
    expect(agg.totalPay.toNumber()).toBe(270);
  });

  it("PER_VIDEO stays per-row (a CPM-less snapshot already paid $0 CPM — unchanged)", () => {
    const agg = computeAggregatePay([
      video(100_000, rate({ viewBonuses: BONUS_50K }), new Date("2026-06-01"), "a"),
      video(
        10_000,
        rate({ viewBonuses: BONUS_50K, cpmRatePerUnit: 2 }),
        new Date("2026-07-01"),
        "b",
      ),
    ]);
    expect(agg.cpmPay.toNumber()).toBe(20);
    expect(agg.totalPay.toNumber()).toBe(70);
  });
});

describe("computeAggregatePay — bonus lane snapshot eligibility", () => {
  it("a bonuses-less snapshot's views do NOT push the aggregate over a tier threshold", () => {
    // OLD video snapshotted WITHOUT bonuses (100k views).
    const oldVideo = video(100_000, rate(), new Date("2026-06-01"), "a-old");
    // NEW video snapshotted WITH a 100k-views/$100 tier (10k views, latest).
    const newVideo = video(
      10_000,
      rate({ viewBonuses: [{ views: 100_000, bonus: 100 }] }),
      new Date("2026-07-01"),
      "b-new",
    );

    const agg = computeAggregatePay([oldVideo, newVideo]);

    // Bonus-eligible views = 10k only → the 100k tier does NOT match.
    expect(agg.bonusPay.toNumber()).toBe(0);
    expect(agg.totalPay.toNumber()).toBe(0);
    // Display totals unchanged.
    expect(agg.totalViews).toBe(110_000);
  });

  it("byte-identical pin: when EVERY snapshot carries the bonus lane, the tier matches exactly as today ($100)", () => {
    const withBonus = (views: number, at: string, key: string) =>
      video(
        views,
        rate({ viewBonuses: [{ views: 100_000, bonus: 100 }] }),
        new Date(at),
        key,
      );

    const agg = computeAggregatePay([
      withBonus(100_000, "2026-06-01", "a"),
      withBonus(10_000, "2026-07-01", "b"),
    ]);

    expect(agg.bonusPay.toNumber()).toBe(100);
    expect(agg.totalPay.toNumber()).toBe(100);
  });

  it("an overridden video's views still count toward the bonus aggregate when its snapshot has the lane", () => {
    const overridden: AggregateVideoInput = {
      bestViews: 60_000,
      rate: rate({ viewBonuses: BONUS_50K }),
      override: new Decimal(5),
      excluded: false,
      postedAt: new Date("2026-06-01"),
      dealKey: "a",
    };
    const normal = video(
      1_000,
      rate({ viewBonuses: BONUS_50K }),
      new Date("2026-07-01"),
      "b",
    );

    const agg = computeAggregatePay([overridden, normal]);
    // 61k aggregate views ≥ 50k tier → $50 bonus + $5 override.
    expect(agg.bonusPay.toNumber()).toBe(50);
    expect(agg.totalPay.toNumber()).toBe(55);
  });
});
