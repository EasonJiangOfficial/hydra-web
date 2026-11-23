import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dealSchema, normalizeHandle as appHandle, normalizePostUrl as appUrl } from "@/lib/ugc/schemas";
import {
  addCounts,
  buildPayloads,
  buildPlan,
  checkLedger,
  cleanText,
  loadLogos,
  normalizeHandle,
  normalizePostUrl,
  payloadSql,
  planCounts,
  sniffImage,
  uploadLogos,
  type Payload,
  type RippleExport,
} from "./import-ripple.mjs";

const OWNER = "owner-1";

function campaign(over: Partial<RippleExport["campaigns"][number]>): RippleExport["campaigns"][number] {
  return {
    id: "c",
    userId: OWNER,
    name: "Brand",
    logo: null,
    brandId: null,
    isMaster: false,
    masterCampaignId: null,
    archivedAt: null,
    createdAt: "2026-10-01T12:00:00",
    paymentPerVideo: null,
    basePayMinViews: 0,
    viewBonuses: null,
    viewBonusMode: "REPLACE",
    cpmRate: null,
    cpmViewUnit: 1000,
    cpmCapViews: null,
    cpmMinViews: null,
    cpmTiers: null,
    cpmMode: "ADD",
    tierEvaluationMode: "PER_VIDEO",
    viewAggregationMode: "HIGHEST",
    viewFreezeDays: null,
    retainerEnabled: false,
    retainerAmount: null,
    flatRateEnabled: false,
    flatRateAmount: null,
    dailyVideos: 1,
    payCycleFrequency: null,
    payCycleAnchorDay: null,
    payCycleAnchorWeekday: null,
    payCycleAnchorDays: [],
    ...over,
  };
}

function post(over: Partial<RippleExport["posts"][number]>): RippleExport["posts"][number] {
  return {
    id: "p",
    connectedAccountId: "a-tt",
    platformPostId: "100",
    platform: "TIKTOK",
    caption: null,
    permalinkUrl: null,
    viewCount: 0,
    likeCount: 0,
    commentCount: 0,
    postedAt: "2026-10-02T10:00:00",
    createdAt: "2026-10-02T10:05:00",
    updatedAt: "2026-10-02T10:05:00",
    viewsSyncedAt: null,
    excludeFromEarnings: false,
    markedIrrelevantAt: null,
    manualEarningsOverride: null,
    paymentPerVideoSnapshot: null,
    basePayMinViewsSnapshot: 0,
    viewBonusesSnapshot: null,
    viewBonusModeSnapshot: "REPLACE",
    cpmRateSnapshot: null,
    cpmViewUnitSnapshot: 1000,
    cpmCapViewsSnapshot: null,
    cpmMinViewsSnapshot: null,
    cpmTiersSnapshot: null,
    cpmModeSnapshot: "ADD",
    tierEvaluationModeSnapshot: "PER_VIDEO",
    ...over,
  };
}

function fixture(): RippleExport {
  return {
    owner: { id: OWNER, email: "owner@example.test" },
    site: { viewFreezeDays: 14 },
    campaigns: [
      campaign({ id: "m1", name: "Glow", isMaster: true, logo: "campaign-logos/m1/logo.jpg", paymentPerVideo: 40 }),
      campaign({
        id: "d1",
        name: "Glow",
        masterCampaignId: "m1",
        paymentPerVideo: 35,
        basePayMinViews: 1000,
        viewBonuses: [
          { views: 50000, bonus: 75 },
          { views: 10000, bonus: 50.5 },
        ],
        cpmRate: 2.25,
        dailyVideos: 3,
        retainerEnabled: true,
        retainerAmount: 100,
        flatRateEnabled: false,
        flatRateAmount: 500,
      }),
      campaign({ id: "d2", name: "Old", archivedAt: "2026-10-20T03:00:00", createdAt: "2026-09-01T00:00:00" }),
    ],
    brands: [],
    foreign_masters: [],
    accounts: [
      { id: "a-tt", platform: "TIKTOK", platformUserId: "u1", username: "Me.Creates", campaignId: "d1" },
      { id: "a-tt2", platform: "TIKTOK", platformUserId: "u1", username: "@me.creates", campaignId: "d1" },
      { id: "a-ig", platform: "INSTAGRAM", platformUserId: "u2", username: "me", campaignId: "d1" },
      { id: "a-old", platform: "TIKTOK", platformUserId: "u1", username: "Me.Creates", campaignId: "d2" },
      { id: "a-none", platform: "TIKTOK", platformUserId: "u3", username: "loose", campaignId: null },
    ],
    posts: [
      // Readings inside the window; the last of each day is kept.
      // Every rate snapshot column set, so each one is checked end to end.
      post({
        id: "p1",
        viewCount: 900,
        manualEarningsOverride: 12.5,
        paymentPerVideoSnapshot: 35,
        basePayMinViewsSnapshot: 1000,
        viewBonusesSnapshot: [{ views: 10000, bonus: 50 }],
        viewBonusModeSnapshot: "ADD",
        cpmRateSnapshot: "2.125",
        cpmViewUnitSnapshot: 500,
        cpmCapViewsSnapshot: 250000,
        cpmMinViewsSnapshot: 2000,
        cpmTiersSnapshot: [
          { views: 100000, ratePerUnit: 3.5 },
          { views: 50000, ratePerUnit: 3 },
        ],
        cpmModeSnapshot: "REPLACE",
        tierEvaluationModeSnapshot: "COMBINED_BRACKETED",
      }),
      // Instagram numeric Graph id, no permalink: placeholder URL. Marked irrelevant: excluded.
      post({ id: "p2", connectedAccountId: "a-ig", platform: "INSTAGRAM", platformPostId: "18179015398386191", markedIrrelevantAt: "2026-10-03T00:00:00" }),
      // Same TikTok video on the archived deal: the active deal's copy wins.
      post({ id: "p3", connectedAccountId: "a-old", platformPostId: "100", createdAt: "2026-10-02T11:00:00" }),
      // Synced long after its window: Ripple froze 5000 views, readings only after the window.
      post({ id: "p4", platformPostId: "200", postedAt: "2026-01-01T00:00:00", viewCount: 5000, viewsSyncedAt: "2026-10-01T00:00:00" }),
      // On an account with no deal.
      post({ id: "p5", connectedAccountId: "a-none", platformPostId: "300" }),
    ],
    snapshots: [
      { id: "s1", platformPostId: "p1", views: 100, likes: 1, comments: 0, capturedAt: "2026-10-02T12:00:00" },
      { id: "s2", platformPostId: "p1", views: 400, likes: 2, comments: 0, capturedAt: "2026-10-02T20:00:00" },
      { id: "s3", platformPostId: "p1", views: 900, likes: 3, comments: 1, capturedAt: "2026-10-03T08:00:00" },
      { id: "s4", platformPostId: "p4", views: 5000, likes: null, comments: null, capturedAt: "2026-10-01T00:00:00" },
      { id: "s5", platformPostId: "p3", views: 7, likes: null, comments: null, capturedAt: "2026-10-02T12:00:00" },
    ],
    unified_links: [{ unifiedVideoId: "uv1", platformPostId: "p1" }],
  };
}

describe("Ripple import plan", () => {
  it("keeps the URL and handle rules identical to the app's", () => {
    const urls = [
      "https://www.tiktok.com/@me/video/123?is_from_webapp=1",
      "https://www.instagram.com/reel/DA975SGO2Jp/",
      "https://m.facebook.com/reel/42",
      "https://youtu.be/abc",
      "https://www.facebook.com/watch/?v=1",
      "https://www.facebook.com/story.php?story_fbid=1&id=2",
      "https://m.facebook.com/permalink.php?story_fbid=3&id=4&ref=x",
      "https://www.facebook.com/watch/",
      "https://www.youtube.com/watch?v=abc&t=3",
      "https://youtube.com/shorts/xyz/",
      "http://instagram.com/p/X?igsh=1#c",
      "ftp://nope",
      "not a url",
    ];
    for (const u of urls) expect(normalizePostUrl(u)).toBe(appUrl(u));
    for (const h of [" @@Alex ", "Alex Rivera", "@alex.creates"]) expect(normalizeHandle(h)).toBe(appHandle(h));
  });

  it("maps masters to templates and his campaigns to deals with every pay field", () => {
    const plan = buildPlan(fixture(), "UTC");
    expect(plan.templates.map((t) => [t.key, t.row.brand_name, t.row.base_pay_cents, t.row.logo_path])).toEqual([
      ["m1", "Glow", 4000, "ripple/campaign-logos/m1/logo.jpg"],
    ]);
    const d1 = plan.deals.find((d) => d.key === "d1")!.row;
    expect(d1).toMatchObject({
      status: "active",
      start_date: "2026-10-01",
      end_date: null,
      base_pay_cents: 3500,
      base_min_views: 1000,
      view_bonuses: [
        { views: 10000, bonusCents: 5050 },
        { views: 50000, bonusCents: 7500 },
      ],
      cpm_rate: "2.2500",
      view_freeze_days: 14,
      retainer_cents: 10000,
      flat_rate_cents: null, // lane off in Ripple
      daily_target_posts: 3,
      logo_path: "ripple/campaign-logos/m1/logo.jpg", // the replica uses its master's logo
      source: "ripple",
      source_id: "d1",
    });
    expect(plan.deals.find((d) => d.key === "d2")!.row).toMatchObject({ status: "ended", start_date: "2026-09-01", end_date: "2026-10-20" });
    expect([...plan.logos.keys()]).toEqual(["ripple/campaign-logos/m1/logo.jpg"]);
  });

  it("folds accounts by handle and skips accounts and posts with no deal", () => {
    const plan = buildPlan(fixture(), "UTC");
    const tt = plan.accounts.find((a) => a.key === "d1|TIKTOK|me.creates")!;
    expect(tt.rippleIds).toEqual(["a-tt", "a-tt2"]);
    expect(plan.accounts).toHaveLength(3);
    expect(plan.posts.map((p) => p.key).sort()).toEqual(["p1", "p2", "p4"]);
    expect(plan.ledger.posts.parts).toEqual({
      "skipped: account not on an imported deal": 1,
      "skipped: same URL as another Ripple post": 1,
      posts: 2,
      "posts (placeholder URL)": 1,
    });
    expect(checkLedger(plan)).toEqual([]);
  });

  it("builds URLs, flags and rate snapshots per post", () => {
    const plan = buildPlan(fixture(), "UTC");
    const row = (k: string) => plan.posts.find((p) => p.key === k)!.row;
    expect(row("p1")).toEqual({
      platform: "TIKTOK",
      url: "https://tiktok.com/@Me.Creates/video/100",
      title: null,
      posted_at: "2026-10-02T10:00:00.000Z",
      video_group_id: "uv1",
      exclude_from_pay: false,
      manual_override_cents: 1250,
      base_pay_cents_snap: 3500,
      base_min_views_snap: 1000,
      view_bonuses_snap: [{ views: 10000, bonusCents: 5000 }],
      view_bonus_mode_snap: "ADD",
      cpm_rate_snap: "2.1250",
      cpm_view_unit_snap: 500,
      cpm_cap_views_snap: 250000,
      cpm_min_views_snap: 2000,
      cpm_tiers_snap: [
        { views: 50000, ratePerUnit: 3 },
        { views: 100000, ratePerUnit: 3.5 },
      ],
      cpm_mode_snap: "REPLACE",
      cpm_tier_mode_snap: "COMBINED_BRACKETED",
      source: "ripple",
      source_id: "p1",
    });
    // No snapshot in Ripple: null, so the pay math falls back to the deal's rate.
    expect(row("p2")).toMatchObject({
      url: "https://ripple.invalid/instagram/18179015398386191",
      exclude_from_pay: true,
      manual_override_cents: null,
      base_pay_cents_snap: null,
      view_bonuses_snap: null,
      cpm_rate_snap: null,
      cpm_cap_views_snap: null,
      cpm_tiers_snap: null,
    });
  });

  it("keeps the last reading per day and adds Ripple's frozen count inside the window", () => {
    const plan = buildPlan(fixture(), "UTC");
    const snaps = (k: string) => plan.snapshots.filter((s) => s.postKey === k).map((s) => [s.row.captured_day, s.row.views, s.rippleIds]);
    expect(snaps("p1")).toEqual([
      ["2026-10-02", 400, ["s1", "s2"]],
      ["2026-10-03", 900, ["s3"]],
    ]);
    const p4 = plan.snapshots.filter((s) => s.postKey === "p4");
    expect(p4.map((s) => [s.row.captured_at, s.row.views, s.synthetic])).toEqual([
      ["2026-10-01T00:00:00.000Z", 5000, false],
      ["2026-01-15T00:00:00.000Z", 5000, true], // posted + 14 days
    ]);
    expect(planCounts(plan)).toMatchObject({ post_view_snapshots: 4, "post_view_snapshots from Ripple view count": 1 });
  });

  it("buckets days in the owner's zone", () => {
    const plan = buildPlan(fixture(), "America/Los_Angeles");
    expect(plan.snapshots.filter((s) => s.postKey === "p1").map((s) => s.row.captured_day)).toEqual(["2026-10-02", "2026-10-03"]);
    expect(plan.snapshots.find((s) => s.postKey === "p1")!.rippleIds).toEqual(["s1", "s2"]);
    expect(plan.deals.find((d) => d.key === "d2")!.row.end_date).toBe("2026-10-19");
  });

  it("imports other users' masters as templates and skips their deals with a warning", () => {
    const exp = fixture();
    exp.brands = [{ id: "b1", brandName: "Brand", brandLogo: "brand-logos/b1.png" }];
    exp.campaigns.push(
      campaign({ id: "m-brand", userId: "b1", brandId: "b1", name: "Brand deal", isMaster: true, paymentPerVideo: 20 }),
      campaign({ id: "m-admin", userId: "admin-2", name: "Admin deal", isMaster: true, archivedAt: "2026-10-05T00:00:00" }),
      campaign({ id: "x", userId: "someone-else", name: "Theirs" }),
    );
    const plan = buildPlan(exp, "UTC");
    expect(plan.templates.map((t) => t.key)).toEqual(["m1", "m-brand", "m-admin"]);
    expect(plan.templates.find((t) => t.key === "m-brand")!.row).toMatchObject({ base_pay_cents: 2000, logo_path: "ripple/brand-logos/b1.png" });
    expect(plan.templates.find((t) => t.key === "m-admin")!.row.archived).toBe(true);
    expect(plan.deals.map((d) => d.key)).toEqual(["d1", "d2"]);
    expect(plan.warnings).toEqual(["campaign x (Theirs) belongs to another Ripple user; not imported"]);
    expect(plan.ledger.campaigns.parts).toEqual({ deal_templates: 3, deals: 2, "skipped: another Ripple user's deal": 1 });
    expect(checkLedger(plan)).toEqual([]);
  });

  it("cleans pay tiers and anchor days so an imported deal and template pass dealSchema", () => {
    const exp = fixture();
    const junk = {
      viewBonuses: [
        { views: 1000, bonus: 5 },
        { views: 1000, bonus: 6 },
        { views: 2000, bonus: -1 },
        { views: 3000, bonus: 7 },
      ],
      cpmRate: 1.5,
      cpmTiers: [
        { views: 5000, ratePerUnit: 3 },
        { views: 5000, ratePerUnit: 4 },
        { views: 9000, ratePerUnit: -2 },
        { views: 20000, ratePerUnit: 2.123456 },
      ],
      cpmCapViews: -5,
      viewFreezeDays: 0,
      dailyVideos: 99,
      payCycleFrequency: "DAYS_OF_MONTH",
      payCycleAnchorDay: 0,
      payCycleAnchorWeekday: 9,
      payCycleAnchorDays: [0, 15, 15, 99, 3],
    };
    exp.campaigns.push(campaign({ id: "junk-d", name: "Junk deal", ...junk }), campaign({ id: "junk-m", name: "Junk master", isMaster: true, ...junk }));
    const plan = buildPlan(exp, "UTC");
    const imported = [...plan.deals, ...plan.templates].filter((i) => i.key.startsWith("junk"));
    expect(imported).toHaveLength(2);
    for (const { row: r } of imported) {
      expect(r.view_bonuses).toEqual([
        { views: 1000, bonusCents: 500 },
        { views: 3000, bonusCents: 700 },
      ]);
      expect(r.cpm_tiers).toEqual([
        { views: 5000, ratePerUnit: 3 },
        { views: 20000, ratePerUnit: 2.1235 },
      ]);
      expect(r).toMatchObject({
        cpm_cap_views: 0,
        view_freeze_days: 1,
        daily_target_posts: 30,
        pay_cycle_anchor_day: 1,
        pay_cycle_anchor_weekday: 6,
        pay_cycle_anchor_days: [1, 3, 15, 31],
      });
      // What updateDeal does: the stored row back to input, then the whole structure through dealSchema.
      const parsed = dealSchema.safeParse({
        brandName: "Renamed",
        logoPath: null,
        startDate: "2026-10-01",
        endDate: null,
        perDealModel: r.per_deal_model,
        basePayCents: r.base_pay_cents,
        baseMinViews: r.base_min_views,
        viewBonuses: r.view_bonuses,
        viewBonusMode: r.view_bonus_mode,
        cpmRate: r.cpm_rate === null ? null : Number(r.cpm_rate),
        cpmViewUnit: r.cpm_view_unit,
        cpmCapViews: r.cpm_cap_views,
        cpmMinViews: r.cpm_min_views,
        cpmTiers: r.cpm_tiers,
        cpmMode: r.cpm_mode,
        cpmTierMode: r.cpm_tier_mode,
        viewAggregationMode: r.view_aggregation_mode,
        viewFreezeDays: r.view_freeze_days,
        retainerCents: r.retainer_cents,
        flatRateCents: r.flat_rate_cents,
        dailyTargetPosts: r.daily_target_posts,
        payCycle: r.pay_cycle,
        payCycleAnchorDay: r.pay_cycle_anchor_day,
        payCycleAnchorWeekday: r.pay_cycle_anchor_weekday,
        payCycleAnchorDays: r.pay_cycle_anchor_days,
        payoutRule: r.payout_rule,
      });
      expect(parsed.error?.issues).toBeUndefined();
    }
  });

  it("warns when COMBINED_FLAT tiers step down", () => {
    const exp = fixture();
    exp.campaigns.push(
      campaign({ id: "flat", name: "Flat", tierEvaluationMode: "COMBINED_FLAT", cpmRate: 5, cpmTiers: [{ views: 500000, ratePerUnit: 1 }] }),
    );
    expect(buildPlan(exp, "UTC").warnings).toEqual([expect.stringContaining('campaign flat (Flat): "Combined: flat" tiers step down')]);
  });

  it("uploads only raster images", () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe("image/png");
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(new TextEncoder().encode("<svg xmlns="))).toBeNull();
  });
});

// ─── Payloads for private.ripple_import_apply (0011) ──────────────────────────

describe("import payloads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const all = (ps: Payload[]) => ({
    templates: ps.flatMap((p) => p.templates),
    deals: ps.flatMap((p) => p.deals),
  });

  it("nests each deal's accounts, posts and their readings under the deal, every item once", () => {
    const plan = buildPlan(fixture(), "UTC");
    const ps = buildPayloads(plan);
    expect(ps).toHaveLength(1);
    const { templates, deals } = all(ps);
    expect(templates.map((t) => t.ripple_ids)).toEqual([["m1"]]);
    expect(deals.map((d) => d.ripple_ids)).toEqual([["d1"], ["d2"]]);
    const d1 = deals[0];
    expect(d1.row).toMatchObject({ source: "ripple", source_id: "d1", base_pay_cents: 3500 });
    expect(d1.accounts.map((a) => [a.key, a.ripple_ids])).toEqual([
      ["d1|TIKTOK|me.creates", ["a-tt", "a-tt2"]],
      ["d1|INSTAGRAM|me", ["a-ig"]],
    ]);
    // A post names an account of its own deal.
    for (const d of deals) for (const p of d.posts) expect(d.accounts.map((a) => a.key)).toContain(p.account);
    const p1 = d1.posts.find((p) => p.ripple_ids[0] === "p1")!;
    expect(p1.row).toEqual(plan.posts.find((p) => p.key === "p1")!.row);
    expect(p1.snapshots.map((s) => [s.ripple_ids, s.row.captured_day, s.row.views])).toEqual([
      [["s1", "s2"], "2026-10-02", 400],
      [["s3"], "2026-10-03", 900],
    ]);
    const posts = deals.flatMap((d) => d.posts);
    expect(posts).toHaveLength(plan.posts.length);
    expect(posts.flatMap((p) => p.snapshots)).toHaveLength(plan.snapshots.length);
    expect(deals.flatMap((d) => d.accounts)).toHaveLength(plan.accounts.length);
  });

  it("splits by size only between deals, templates first", () => {
    const exp = fixture();
    for (let i = 0; i < 6; i++) {
      exp.campaigns.push(campaign({ id: `dx${i}`, name: `Deal ${i}` }));
      exp.accounts.push({ id: `ax${i}`, platform: "YOUTUBE", platformUserId: `ux${i}`, username: `h${i}`, campaignId: `dx${i}` });
      for (let j = 0; j < 20; j++) exp.posts.push(post({ id: `px${i}-${j}`, connectedAccountId: `ax${i}`, platform: "YOUTUBE", platformPostId: `v${i}x${j}`, viewCount: j }));
    }
    const plan = buildPlan(exp, "UTC");
    const ps = buildPayloads(plan, 12_000);
    expect(ps.length).toBeGreaterThan(2);
    expect(ps[0].templates).toHaveLength(1);
    expect(ps.slice(1).every((p) => p.templates.length === 0 && p.deals.length > 0)).toBe(true);
    // Whole deals only: every post of a deal travels with it.
    const { deals } = all(ps);
    expect(deals.map((d) => d.ripple_ids[0]).sort()).toEqual(plan.deals.map((d) => d.key).sort());
    for (const d of deals) {
      expect(d.posts).toHaveLength(plan.posts.filter((p) => p.dealKey === d.ripple_ids[0]).length);
    }
    for (const p of ps) if (p.deals.length > 1) expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(12_000);
  });

  it("drops a logo that did not load", () => {
    const ps = buildPayloads(buildPlan(fixture(), "UTC"), undefined, () => false);
    expect(ps[0].templates[0].row.logo_path).toBeNull();
    expect(ps[0].deals[0].row.logo_path).toBeNull();
  });

  it("writes one statement per payload whose JSON survives any caption", () => {
    const exp = fixture();
    exp.posts[0].caption = "it's $ripple$ time; select 1; -- $ripple_$";
    const p = buildPayloads(buildPlan(exp, "UTC"))[0];
    const sql = payloadSql(p);
    const m = sql.match(/^select private\.ripple_import_apply\((\$\w+\$)([\s\S]*)\1::jsonb\);\n$/);
    expect(m?.[1]).toBe("$ripple__$");
    expect(JSON.parse(m![2])).toEqual(p);
  });

  it("strips NUL and lone surrogates, which jsonb rejects, from every string it sends", () => {
    expect(cleanText("a\u0000b")).toBe("ab");
    expect(cleanText("x\uD83D y \uDE00 z")).toBe("x\uFFFD y \uFFFD z");
    expect(cleanText("ok \uD83D\uDE00 émoji")).toBe("ok \uD83D\uDE00 émoji"); // a real pair stays
    const exp = fixture();
    exp.posts[0].caption = "bad\u0000 \uD83D cut";
    exp.campaigns[1].name = "Glow\u0000";
    const p = buildPayloads(buildPlan(exp, "UTC"))[0];
    const json = JSON.stringify(p);
    expect(json).not.toMatch(/\\u0000|\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i);
    expect(p.deals[0].row.brand_name).toBe("Glow");
    expect(p.deals[0].posts.find((x) => x.ripple_ids[0] === "p1")!.row.title).toBe("bad \uFFFD cut");
  });

  it("adds counts per entity", () => {
    const one = { post: { inserted: 2, skipped_existing: 1, skipped_deleted: 0 } };
    expect(addCounts(addCounts({}, one), { ...one, deal: { inserted: 0, skipped_existing: 0, skipped_deleted: 1 } })).toEqual({
      post: { inserted: 4, skipped_existing: 2, skipped_deleted: 0 },
      deal: { inserted: 0, skipped_existing: 0, skipped_deleted: 1 },
    });
  });

  it("keeps only raster logos, from the cache or the CDN, and reports failed uploads", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const exp = fixture();
    exp.campaigns.push(
      campaign({ id: "m-svg", isMaster: true, name: "Svg", logo: "logos/a.svg" }),
      campaign({ id: "m-gone", isMaster: true, name: "Gone", logo: "logos/gone.png" }),
    );
    const dir = mkdtempSync(join(tmpdir(), "ripple-"));
    for (const [source, bytes] of [
      ["campaign-logos/m1/logo.jpg", PNG],
      ["logos/a.svg", new TextEncoder().encode("<svg xmlns=")],
    ] as const) {
      mkdirSync(dirname(join(dir, "logos", source)), { recursive: true });
      writeFileSync(join(dir, "logos", source), bytes);
    }
    const plan = buildPlan(exp, "UTC");
    const logos = await loadLogos(plan, dir, "https://media.test");
    expect([...logos.keys()]).toEqual(["ripple/campaign-logos/m1/logo.jpg"]);
    expect(logos.get("ripple/campaign-logos/m1/logo.jpg")!.type).toBe("image/png");
    const ps = buildPayloads(plan, undefined, (p) => logos.has(p));
    const logo = (id: string) => ps[0].templates.find((t) => t.ripple_ids[0] === id)!.row.logo_path;
    expect([logo("m1"), logo("m-svg"), logo("m-gone")]).toEqual(["ripple/campaign-logos/m1/logo.jpg", null, null]);

    const uploads: string[] = [];
    const db = {
      storage: {
        from: (bucket: string) => ({
          upload: async (path: string) => (uploads.push(`${bucket}/${path}`), { error: path.includes("m1") ? null : { message: "x" } }),
        }),
      },
    } as unknown as SupabaseClient;
    expect(await uploadLogos(db, logos)).toEqual(new Set());
    expect(uploads).toEqual(["deal-logos/ripple/campaign-logos/m1/logo.jpg"]);
  });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
