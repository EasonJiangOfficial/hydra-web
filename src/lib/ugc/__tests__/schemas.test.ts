/**
 * Input boundary: URL normalization (one row per post), deal pay-structure
 * validation (Ripple's pay-validation guards), payout rules and set-views items.
 */
import { describe, it, expect } from "vitest";
import {
  DEAL_DEFAULTS,
  addPostSchema,
  createDealSchema,
  dealSchema,
  matchesPayoutRule,
  normalizeHandle,
  normalizePostUrl,
  setViewsSchema,
  updateDealSchema,
} from "@/lib/ugc/schemas";
import { DUPLICATE_VIEWS_MESSAGE, FLAT_DECREASING_RATE_MESSAGE } from "@/lib/ugc/pay-validation";

const ID = "3f0c6a52-7d3e-4c1b-9a51-2b8f0e6d4c11";

describe("normalizePostUrl", () => {
  it.each([
    ["https://www.tiktok.com/@me/video/123?is_from_webapp=1&sender_device=pc", "https://tiktok.com/@me/video/123"],
    ["http://instagram.com/reel/AbC_d/", "https://instagram.com/reel/AbC_d"],
    ["https://WWW.Instagram.com/reel/AbC_d/?igsh=xyz#x", "https://instagram.com/reel/AbC_d"],
    ["https://m.youtube.com/watch?v=xYz&t=10s", "https://youtube.com/watch?v=xYz"],
    ["https://youtu.be/xYz?si=abc", "https://youtube.com/watch?v=xYz"],
    ["https://youtube.com/shorts/aBc?feature=share", "https://youtube.com/shorts/aBc"],
    ["  https://facebook.com/reel/42  ", "https://facebook.com/reel/42"],
    ["https://www.facebook.com/watch/?v=1111111111&ref=sharing", "https://facebook.com/watch?v=1111111111"],
    ["https://m.facebook.com/watch?v=2222222222", "https://facebook.com/watch?v=2222222222"],
    ["https://www.facebook.com/story.php?story_fbid=1&id=2&mibextid=x", "https://facebook.com/story.php?story_fbid=1&id=2"],
    ["https://facebook.com/permalink.php?id=4&story_fbid=3", "https://facebook.com/permalink.php?story_fbid=3&id=4"],
    ["https://www.facebook.com/brand/posts/987?__cft__=x", "https://facebook.com/brand/posts/987"],
    ["https://www.facebook.com/watch/", null],
    ["https://www.facebook.com/story.php?story_fbid=1", null],
    ["https://youtube.com/watch", null],
    ["https://youtu.be/", null],
    ["ftp://tiktok.com/@me/video/1", null],
    ["not a url", null],
  ])("%s → %s", (raw, url) => expect(normalizePostUrl(raw)).toBe(url));

  it("addPost stores the normalized URL and handle", () => {
    const r = addPostSchema.parse({
      dealId: ID,
      url: "https://www.tiktok.com/@me/video/1?x=1",
      platform: "TIKTOK",
      account: " @MyHandle",
      postedAt: "2026-11-02T10:00:00-05:00",
    });
    expect(r).toMatchObject({ url: "https://tiktok.com/@me/video/1", account: "myhandle", source: "hydra" });
    expect(normalizeHandle("@@Me")).toBe("me");
    expect(addPostSchema.safeParse({ dealId: ID, url: "nope", platform: "TIKTOK", postedAt: "2026-11-02T10:00:00Z" }).success).toBe(false);
  });
});

describe("deal pay structure", () => {
  const valid = { ...DEAL_DEFAULTS, brandName: "Glow", startDate: "2026-11-01" };
  const issue = (over: object) => {
    const r = dealSchema.safeParse({ ...valid, ...over });
    return r.success ? null : r.error.issues[0]!.message;
  };

  it("a create needs only a brand and a start date; defaults fill the rest", () => {
    const parsed = createDealSchema.parse({ brandName: " Glow ", startDate: "2026-11-01" });
    expect(parsed).toMatchObject({ brandName: "Glow", source: "hydra", sourceId: null });
    const full = dealSchema.parse({ ...DEAL_DEFAULTS, brandName: parsed.brandName, startDate: parsed.startDate });
    expect(full).toMatchObject({ dailyTargetPosts: 1, perDealModel: false, viewBonusMode: "REPLACE", cpmMode: "ADD" });
  });

  it.each([
    { name: "valid", over: {}, message: null },
    {
      name: "duplicate bonus thresholds",
      over: { viewBonuses: [{ views: 10_000, bonusCents: 1 }, { views: 10_000, bonusCents: 2 }] },
      message: DUPLICATE_VIEWS_MESSAGE,
    },
    {
      name: "duplicate CPM thresholds",
      over: { cpmTiers: [{ views: 500_000, ratePerUnit: 1.5 }, { views: 500_000, ratePerUnit: 3 }] },
      message: DUPLICATE_VIEWS_MESSAGE,
    },
    {
      name: "a COMBINED_FLAT cliff",
      over: { cpmTierMode: "COMBINED_FLAT", cpmRate: 5, cpmTiers: [{ views: 500_000, ratePerUnit: 1 }] },
      message: FLAT_DECREASING_RATE_MESSAGE,
    },
    {
      name: "the same tiers are fine when marginal",
      over: { cpmTierMode: "COMBINED_BRACKETED", cpmRate: 5, cpmTiers: [{ views: 500_000, ratePerUnit: 1 }] },
      message: null,
    },
    { name: "end before start", over: { endDate: "2026-10-31" }, message: "End date is before the start date" },
    { name: "a target above 30", over: { dailyTargetPosts: 31 }, message: expect.any(String) },
    { name: "fractional cents", over: { basePayCents: 25.5 }, message: expect.any(String) },
    { name: "infinite rate", over: { cpmRate: Number.POSITIVE_INFINITY }, message: expect.any(String) },
    { name: "payout min above max", over: { payoutRule: { minCents: 10, maxCents: 5 } }, message: "Minimum is above maximum" },
    { name: "unknown payout rule key", over: { payoutRule: { regex: ".*" } }, message: expect.any(String) },
  ])("$name", ({ over, message }) => expect(issue(over)).toEqual(message));

  it("rounds a CPM rate to 4 decimals (numeric(12,4))", () => {
    expect(dealSchema.parse({ ...valid, cpmRate: 2.123456 }).cpmRate).toBe(2.1235);
  });

  it("an update needs the id and keeps omitted fields out", () => {
    expect(updateDealSchema.safeParse({ basePayCents: 100 }).success).toBe(false);
    expect(updateDealSchema.parse({ id: ID, basePayCents: 100 })).toEqual({ id: ID, basePayCents: 100 });
  });
});

describe("matchesPayoutRule", () => {
  const dep = (name: string, amountCents: number) => ({ name, amountCents });
  it.each([
    { rule: {}, d: dep("GLOW INC PAYOUT", 5_000), match: false },
    { rule: { payerContains: "glow" }, d: dep("GLOW INC PAYOUT", 5_000), match: true },
    { rule: { payerContains: "glow" }, d: dep("PULSE LLC", 5_000), match: false },
    { rule: { payerContains: "glow", minCents: 6_000 }, d: dep("Glow", 5_000), match: false },
    { rule: { payerContains: "glow", maxCents: 4_000 }, d: dep("Glow", 5_000), match: false },
    { rule: { minCents: 1_000, maxCents: 9_000 }, d: dep("anyone", 5_000), match: true },
    { rule: { payerContains: "glow" }, d: dep("Glow refund", -5_000), match: false },
  ])("$rule vs $d.name $d.amountCents → $match", ({ rule, d, match }) => {
    expect(matchesPayoutRule(rule, d)).toBe(match);
  });
});

describe("setViews items", () => {
  const base = { capturedAt: "2026-11-03T12:00:00Z" };
  it("takes a post id or a URL, not both, not neither", () => {
    expect(setViewsSchema.safeParse({ ...base, items: [{ postId: ID, views: 10 }] }).success).toBe(true);
    expect(setViewsSchema.safeParse({ ...base, items: [{ url: "https://tiktok.com/@me/video/1", views: 10 }] }).success).toBe(true);
    expect(
      setViewsSchema.safeParse({ ...base, items: [{ postId: ID, url: "https://tiktok.com/@me/video/1", views: 10 }] }).success,
    ).toBe(false);
    expect(setViewsSchema.safeParse({ ...base, items: [{ views: 10 }] }).success).toBe(false);
  });

  it("rejects negative, fractional and missing counts", () => {
    for (const views of [-1, 1.5, undefined]) {
      expect(setViewsSchema.safeParse({ ...base, items: [{ postId: ID, views }] }).success).toBe(false);
    }
    expect(setViewsSchema.parse({ ...base, items: [{ postId: ID, views: 1 }] }).force).toBe(false);
  });
});
