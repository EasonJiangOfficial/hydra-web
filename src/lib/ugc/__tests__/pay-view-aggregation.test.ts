/**
 * Stack 2 — Campaign.viewAggregationMode (HIGHEST | COMBINED).
 *
 * HIGHEST (default) = today's best-platform-max collapse, byte-identical.
 * COMBINED = a cross-platform video group's views SUM into its payable count.
 * Exact-dollar pins on the shared helper and calcPay (ported from Ripple; the
 * dashboard-earnings and pay-post cases were not ported with those modules).
 */
import { describe, it, expect } from "vitest";
import {
  resolveViewAggregationMode,
  groupPayViews,
} from "@/lib/ugc/pay-aggregate";
import { calcPay } from "@/lib/ugc/campaign-earnings";

describe("resolveViewAggregationMode", () => {
  it("defaults to HIGHEST for null/undefined/absent/unknown values", () => {
    expect(resolveViewAggregationMode(null)).toBe("HIGHEST");
    expect(resolveViewAggregationMode(undefined)).toBe("HIGHEST");
    expect(resolveViewAggregationMode({})).toBe("HIGHEST");
    expect(resolveViewAggregationMode({ viewAggregationMode: null })).toBe(
      "HIGHEST",
    );
    expect(
      resolveViewAggregationMode({ viewAggregationMode: "GARBAGE" }),
    ).toBe("HIGHEST");
  });

  it("returns COMBINED only for the exact enum value", () => {
    expect(
      resolveViewAggregationMode({ viewAggregationMode: "COMBINED" }),
    ).toBe("COMBINED");
    expect(
      resolveViewAggregationMode({ viewAggregationMode: "HIGHEST" }),
    ).toBe("HIGHEST");
  });
});

describe("groupPayViews", () => {
  it("HIGHEST takes the max; COMBINED sums", () => {
    expect(groupPayViews([600, 600], "HIGHEST")).toBe(600);
    expect(groupPayViews([600, 600], "COMBINED")).toBe(1200);
    expect(groupPayViews([100, 900, 50], "HIGHEST")).toBe(900);
    expect(groupPayViews([100, 900, 50], "COMBINED")).toBe(1050);
  });

  it("single-platform groups are identical in both modes", () => {
    expect(groupPayViews([1500], "HIGHEST")).toBe(1500);
    expect(groupPayViews([1500], "COMBINED")).toBe(1500);
  });

  it("empty input is 0 in both modes", () => {
    expect(groupPayViews([], "HIGHEST")).toBe(0);
    expect(groupPayViews([], "COMBINED")).toBe(0);
  });
});

describe("campaign-earnings calcPay — viewAggregationMode", () => {
  // Base $10 gated at 1000 views + a $20 tier at 1000 views (ADD).
  const tiers = [{ views: 1000, bonus: 20 }];

  it("exact dollars: 600+600 pays $0 under HIGHEST, $30 under COMBINED", () => {
    const highest = calcPay([600, 600], 10, tiers, "ADD", 1000, undefined, {
      viewAggregationMode: "HIGHEST",
    });
    expect(highest.pay).toBe(0);

    const combined = calcPay([600, 600], 10, tiers, "ADD", 1000, undefined, {
      viewAggregationMode: "COMBINED",
    });
    expect(combined.pay).toBe(30);
  });

  it("single-platform videos are byte-identical across modes", () => {
    const highest = calcPay([1500], 10, tiers, "ADD", 1000, undefined, {
      viewAggregationMode: "HIGHEST",
    });
    const combined = calcPay([1500], 10, tiers, "ADD", 1000, undefined, {
      viewAggregationMode: "COMBINED",
    });
    expect(highest.pay).toBe(30);
    expect(combined.pay).toBe(30);
  });

  it("omitting the option keeps today's HIGHEST behavior (regression pin)", () => {
    expect(calcPay([600, 600], 10, tiers, "ADD", 1000).pay).toBe(0);
  });
});
