/** The deals row mapping: every pay column lands in its own column and comes back unchanged. */
import { describe, it, expect } from "vitest";
import { DEAL_DEFAULTS, dealInputToRow, dealRowToInput, type DealDbRow, type DealInput } from "@/lib/ugc/schemas";

const full: DealInput = {
  brandName: "Acme",
  logoPath: "logos/acme.png",
  startDate: "2026-11-01",
  endDate: "2026-12-01",
  perDealModel: true,
  basePayCents: 5000,
  baseMinViews: 1000,
  viewBonuses: [{ views: 10_000, bonusCents: 2500 }],
  viewBonusMode: "ADD",
  cpmRate: 2.5,
  cpmViewUnit: 1000,
  cpmCapViews: 500_000, // the cap and the floor are different numbers on purpose
  cpmMinViews: 3_000,
  cpmTiers: [{ views: 50_000, ratePerUnit: 3 }],
  cpmMode: "REPLACE",
  cpmTierMode: "COMBINED_BRACKETED",
  viewAggregationMode: "COMBINED",
  viewFreezeDays: 21,
  retainerCents: 150_000,
  flatRateCents: 7500,
  dailyTargetPosts: 3,
  payCycle: "DAYS_OF_MONTH",
  payCycleAnchorDay: 15,
  payCycleAnchorWeekday: 2,
  payCycleAnchorDays: [1, 15],
  payoutRule: { payerContains: "acme", minCents: 100, maxCents: 900 },
};

const stored = (row: ReturnType<typeof dealInputToRow>, over: Record<string, unknown> = {}) =>
  ({
    ...row,
    id: "id",
    entity_id: "e",
    status: "active",
    source: "hydra",
    source_id: null,
    created_at: "x",
    updated_at: "y",
    ...over,
  }) as unknown as DealDbRow;

describe("dealInputToRow", () => {
  it("puts the CPM cap in cpm_cap_views and the floor in cpm_min_views", () => {
    const row = dealInputToRow(full);
    expect(row.cpm_cap_views).toBe(500_000);
    expect(row.cpm_min_views).toBe(3_000);
  });

  it("maps every field to its own column", () => {
    expect(dealInputToRow(full)).toEqual({
      brand_name: "Acme",
      logo_path: "logos/acme.png",
      start_date: "2026-11-01",
      end_date: "2026-12-01",
      per_deal_model: true,
      base_pay_cents: 5000,
      base_min_views: 1000,
      view_bonuses: [{ views: 10_000, bonusCents: 2500 }],
      view_bonus_mode: "ADD",
      cpm_rate: 2.5,
      cpm_view_unit: 1000,
      cpm_cap_views: 500_000,
      cpm_min_views: 3_000,
      cpm_tiers: [{ views: 50_000, ratePerUnit: 3 }],
      cpm_mode: "REPLACE",
      cpm_tier_mode: "COMBINED_BRACKETED",
      view_aggregation_mode: "COMBINED",
      view_freeze_days: 21,
      retainer_cents: 150_000,
      flat_rate_cents: 7500,
      daily_target_posts: 3,
      pay_cycle: "DAYS_OF_MONTH",
      pay_cycle_anchor_day: 15,
      pay_cycle_anchor_weekday: 2,
      pay_cycle_anchor_days: [1, 15],
      payout_rule: { payerContains: "acme", minCents: 100, maxCents: 900 },
    });
  });
});

describe("dealRowToInput", () => {
  it("round-trips a full deal", () => {
    expect(dealRowToInput(stored(dealInputToRow(full)))).toEqual(full);
  });

  it("round-trips the defaults", () => {
    const d: DealInput = { ...DEAL_DEFAULTS, brandName: "Acme", startDate: "2026-11-01" };
    expect(dealRowToInput(stored(dealInputToRow(d)))).toEqual(d);
  });

  it("reads the cap and the floor from their own columns", () => {
    const input = dealRowToInput(stored({ ...dealInputToRow(full), cpm_cap_views: 9, cpm_min_views: 4 }));
    expect(input.cpmCapViews).toBe(9);
    expect(input.cpmMinViews).toBe(4);
  });

  it("coerces numeric strings (PostgREST returns numeric and bigint as strings)", () => {
    const input = dealRowToInput(
      stored(dealInputToRow(full), { cpm_rate: "2.5", retainer_cents: "150000", flat_rate_cents: "7500", base_pay_cents: "5000" }),
    );
    expect(input.cpmRate).toBe(2.5);
    expect(input.retainerCents).toBe(150_000);
    expect(input.flatRateCents).toBe(7500);
    expect(input.basePayCents).toBe(5000);
  });

  it("keeps null money null, not 0", () => {
    const input = dealRowToInput(stored(dealInputToRow({ ...full, cpmRate: null, retainerCents: null, flatRateCents: null, basePayCents: null })));
    expect(input).toMatchObject({ cpmRate: null, retainerCents: null, flatRateCents: null, basePayCents: null });
  });

  it("turns null arrays and a null payout rule into empty ones", () => {
    const input = dealRowToInput(
      stored(dealInputToRow(full), { view_bonuses: null, cpm_tiers: null, pay_cycle_anchor_days: null, payout_rule: null }),
    );
    expect(input).toMatchObject({ viewBonuses: [], cpmTiers: [], payCycleAnchorDays: [], payoutRule: {} });
  });
});
