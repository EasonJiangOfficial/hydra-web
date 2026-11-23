// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { brandPosts, brandSummary, engagementRate, followerStats, setFollowersSchema } from "@/lib/brand/model";
import { loadBrandRaw, saveFollowerCount } from "@/lib/brand/queries";
import { matchThumbs, shortcodeOf } from "@/lib/brand/thumbs";
import { readLatestEngagement } from "@/lib/ugc/analytics-queries";
import { ugcDealsOnly } from "@/lib/ugc/personal";
import type { Db } from "@/lib/ugc/writes";

let current: Db;
vi.mock("@/lib/supabase/server", () => ({ createServerClient: async () => current }));
vi.mock("server-only", () => ({}));


const ZONE = "America/Toronto";
const NOW = new Date("2026-11-21T15:00:00.000Z");

/**
 * A PostgREST stand-in: each table's rows, filtered by the chain's eq / in calls (embedded filters such as
 * "deals.personal_brand" read the embedded row), paged by range. Records every call.
 */
function fakeDb(tables: Record<string, Record<string, unknown>[]>) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  const db = {
    rpc: async () => ({ data: true, error: null }),
    from(table: string) {
      const filters: ((r: Record<string, unknown>) => boolean)[] = [];
      let range: [number, number] | null = null;
      let single = false;
      const get = (r: Record<string, unknown>, col: string) =>
        col.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], r);
      const chain: unknown = new Proxy(
        {},
        {
          get: (_t, op: string) => {
            if (op === "then") {
              return (res: (v: unknown) => unknown) => {
                let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
                if (range) rows = rows.slice(range[0], range[1] + 1);
                return res({ data: single ? (rows[0] ?? null) : rows, error: null });
              };
            }
            return (...args: unknown[]) => {
              calls.push({ table, op, args });
              if (op === "eq") filters.push((r) => get(r, args[0] as string) === args[1]);
              if (op === "in") filters.push((r) => (args[1] as unknown[]).includes(get(r, args[0] as string)));
              if (op === "range") range = [args[0] as number, args[1] as number];
              if (op === "maybeSingle" || op === "single") single = true;
              return chain;
            };
          },
        },
      );
      return chain;
    },
  };
  return { db: db as unknown as Db, calls };
}

const PB = "00000000-0000-4000-8000-000000000201";
const UGC = "00000000-0000-4000-8000-000000000101";

function deal(id: string, name: string, personal: boolean) {
  return {
    id,
    entity_id: "e",
    brand_name: name,
    personal_brand: personal,
    status: "active",
    start_date: "2026-11-01",
    end_date: null,
    per_deal_model: false,
    base_pay_cents: 2500,
    base_min_views: 0,
    view_bonuses: [],
    view_bonus_mode: "REPLACE",
    cpm_rate: null,
    cpm_view_unit: 1000,
    cpm_cap_views: null,
    cpm_min_views: null,
    cpm_tiers: [],
    cpm_mode: "ADD",
    cpm_tier_mode: "PER_VIDEO",
    view_aggregation_mode: "HIGHEST",
    view_freeze_days: null,
    retainer_cents: null,
    flat_rate_cents: null,
    daily_target_posts: 1,
    pay_cycle: null,
    pay_cycle_anchor_day: null,
    pay_cycle_anchor_weekday: null,
    pay_cycle_anchor_days: [],
    payout_rule: {},
    paused_spans: [],
    source: "ripple",
    source_id: id,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  };
}

function post(id: string, dealId: string, postedAt: string) {
  return {
    id,
    deal_id: dealId,
    account_id: null,
    platform: "INSTAGRAM",
    url: `https://www.instagram.com/reel/${id}/`,
    title: null,
    posted_at: postedAt,
    video_group_id: null,
    exclude_from_pay: false,
    manual_override_cents: null,
    base_pay_cents_snap: 2500,
    base_min_views_snap: 0,
    view_bonuses_snap: [],
    view_bonus_mode_snap: "REPLACE",
    cpm_rate_snap: null,
    cpm_view_unit_snap: 1000,
    cpm_cap_views_snap: null,
    cpm_min_views_snap: null,
    cpm_tiers_snap: [],
    cpm_mode_snap: "ADD",
    cpm_tier_mode_snap: "PER_VIDEO",
    deals: { personal_brand: dealId === PB },
  };
}

const view = (postId: string, dealId: string, views: number) => ({
  post_id: postId,
  deal_id: dealId,
  payable_views: views,
  latest_views: views,
  last_captured_at: "2026-11-20T12:00:00Z",
  last_captured_day: "2026-11-20",
  latest_held: false,
});

function tables() {
  return {
    settings: [{ time_zone: ZONE }],
    deals: [deal(UGC, "Wordwise", false), deal(PB, "Personal Brand", true)],
    posts: [post("u1", UGC, "2026-11-10T15:00:00Z"), post("b1", PB, "2026-11-12T15:00:00Z"), post("b2", PB, "2026-11-19T15:00:00Z")],
    ugc_post_views: [view("u1", UGC, 1000), view("b1", PB, 2000), view("b2", PB, 8000)],
    deal_payments: [],
    day_targets: [],
    deal_accounts: [
      { id: "a1", deal_id: UGC, platform: "TIKTOK", handle: "wordwise.ugc" },
      { id: "a2", deal_id: PB, platform: "INSTAGRAM", handle: "me" },
    ],
    personal_brand_followers: [
      { day: "2026-11-01", followers: 1000, source: "manual" },
      { day: "2026-11-15", followers: "1100", source: "manual" },
      { day: "2026-11-20", followers: 1240, source: "sync" },
    ],
  };
}

describe("Personal Brand model", () => {
  it("engagement rate is likes plus comments over views, null with no views", () => {
    const p = (views: number, likes: number | null, comments: number | null) => ({
      id: `p${views}`, dealId: PB, platform: "INSTAGRAM" as const, postedAt: "2026-11-20T15:00:00Z", groupId: null, views, likes, comments,
    });
    expect(engagementRate([p(1000, 40, 10)])).toBe(0.05);
    expect(engagementRate([p(0, 3, 0)])).toBeNull();
    // A post with no likes or comments reading leaves the denominator too: 50 / 1000, not 50 / 15000.
    expect(engagementRate([p(1000, 40, 10), p(14_000, null, null)])).toBe(0.05);
    expect(engagementRate([p(14_000, null, null)])).toBeNull();
  });

  it("keeps a post flagged exclude_from_pay (pay logic, not the owner's own account)", async () => {
    const t = tables();
    t.posts = t.posts.map((p) => (p.id === "b1" ? { ...p, exclude_from_pay: true } : p));
    const raw = await loadBrandRaw(fakeDb(t).db, NOW);
    expect(brandPosts(raw).map((p) => p.id).sort()).toEqual(["b1", "b2"]);
    expect(brandSummary(raw, { from: null, to: NOW }).views).toBe(10_000);
  });

  it("follower change counts from the last reading before the window", () => {
    const rows = [
      { day: "2026-11-01", followers: 1000, source: "manual" as const },
      { day: "2026-11-15", followers: 1100, source: "manual" as const },
      { day: "2026-11-20", followers: 1240, source: "sync" as const },
    ];
    const week = followerStats(rows, { from: new Date("2026-11-14T15:00:00Z"), to: NOW }, ZONE);
    expect(week.points.map((p) => p.day)).toEqual(["2026-11-15", "2026-11-20"]);
    expect(week.change).toBe(240);
    expect(week.latest?.followers).toBe(1240);
    const all = followerStats(rows, { from: null, to: NOW }, ZONE);
    expect(all.change).toBe(240);
    expect(followerStats(rows.slice(0, 1), { from: null, to: NOW }, ZONE).change).toBeNull();
  });

  it("refuses a negative or fractional count", () => {
    expect(setFollowersSchema.safeParse({ followers: -1 }).success).toBe(false);
    expect(setFollowersSchema.safeParse({ followers: 1.5 }).success).toBe(false);
    expect(setFollowersSchema.safeParse({ followers: 1240 }).success).toBe(true);
  });
});

describe("saveFollowerCount", () => {
  it("saves under the owner-zone day worked out on the server", async () => {
    const { db, calls } = fakeDb(tables());
    // 03:00 UTC on the 22nd is still the 21st in Toronto.
    const res = await saveFollowerCount(db, 1300, new Date("2026-11-22T03:00:00Z"));
    expect(res).toEqual({ ok: true, data: { day: "2026-11-21", followers: 1300 } });
    expect(calls).toContainEqual({
      table: "personal_brand_followers",
      op: "upsert",
      args: [{ day: "2026-11-21", followers: 1300, source: "manual" }, { onConflict: "day" }],
    });
  });

  it("keeps a synced count for the day", async () => {
    const { db, calls } = fakeDb(tables());
    const res = await saveFollowerCount(db, 1300, new Date("2026-11-20T18:00:00Z"));
    expect(res.ok).toBe(false);
    expect(calls.some((c) => c.op === "upsert")).toBe(false);
  });
});

describe("thumbnails from the account's media list", () => {
  it("matches every post by shortcode, video thumbnail or image, CDN hosts only", () => {
    const posts = [
      { id: "a", url: "https://www.instagram.com/reel/AAA111/" },
      { id: "b", url: "https://instagram.com/p/BBB222/?igsh=x" },
      { id: "c", url: "https://www.instagram.com/p/CCC333/" },
      { id: "d", url: "https://www.instagram.com/p/DDD444/" },
    ];
    const thumbs = matchThumbs(posts, [
      { shortcode: "AAA111", media_type: "VIDEO", media_url: "https://video.cdninstagram.com/v.mp4", thumbnail_url: "https://scontent.cdninstagram.com/a.jpg" },
      { permalink: "https://www.instagram.com/p/BBB222/", media_type: "IMAGE", media_url: "https://scontent-yyz1-1.xx.fbcdn.net/b.jpg" },
      { shortcode: "CCC333", media_type: "IMAGE", media_url: "https://evil.example.com/c.jpg" },
    ]);
    expect(thumbs).toEqual({ a: "https://scontent.cdninstagram.com/a.jpg", b: "https://scontent-yyz1-1.xx.fbcdn.net/b.jpg" });
    expect(shortcodeOf("https://www.tiktok.com/@me/video/1")).toBeNull();
  });
});

describe("loadBrandRaw", () => {
  it("reads only the flagged deals' posts, views and handle, and the follower counts", async () => {
    const { db } = fakeDb(tables());
    const raw = await loadBrandRaw(db, NOW);
    expect(raw.deals.map((d) => d.brand_name)).toEqual(["Personal Brand"]);
    expect(raw.posts.map((p) => p.id).sort()).toEqual(["b1", "b2"]);
    expect(raw.views.map((v) => v.post_id).sort()).toEqual(["b1", "b2"]);
    expect(raw.handle).toBe("me");
    expect(raw.followers.map((f) => f.followers)).toEqual([1000, 1100, 1240]);

    const s = brandSummary(raw, { from: null, to: NOW });
    expect(s.posts).toBe(2);
    expect(s.views).toBe(10_000);
    expect(s.followers).toMatchObject({ latest: 1240, latestDay: "2026-11-20", changeInRange: 240 });
    expect(s.topPosts[0]).toMatchObject({ url: "https://www.instagram.com/reel/b2/", views: 8000, postedDay: "2026-11-19" });
  });

  it("with no flagged deal, reads no posts", async () => {
    const t = tables();
    t.deals = [deal(UGC, "Wordwise", false)];
    const { db, calls } = fakeDb(t);
    const raw = await loadBrandRaw(db, NOW);
    expect(raw.posts).toEqual([]);
    expect(calls.some((c) => c.table === "posts")).toBe(false);
  });

  it("scopes the likes and comments read to the given deals", async () => {
    const { db, calls } = fakeDb({ posts: [] });
    await readLatestEngagement(db, [PB]);
    expect(calls).toContainEqual({ table: "posts", op: "in", args: ["deal_id", [PB]] });
  });
});

describe("the UGC tracker leaves Personal Brand out", () => {
  it("drops the flagged deal and every row of it", () => {
    const t = tables();
    const { deals, has } = ugcDealsOnly(t.deals);
    expect(deals.map((d) => d.brand_name)).toEqual(["Wordwise"]);
    expect(t.posts.filter(has).map((p) => p.id)).toEqual(["u1"]);
    expect(t.deal_accounts.filter(has).map((a) => a.handle)).toEqual(["wordwise.ugc"]);
    // A row from before 0140 (no column) counts as UGC.
    expect(ugcDealsOnly([{ id: "x" }]).deals).toHaveLength(1);
  });

  it("listDeals leaves the flagged deal out, and still loads a database from before 0140", async () => {
    // Imported here: its "server-only" import resolves only through the mock above.
    const { listDeals } = await import("@/lib/ugc/queries");
    current = fakeDb(tables()).db;
    expect((await listDeals({ now: NOW })).deals.map((d) => d.deal.brand_name)).toEqual(["Wordwise"]);
    const old = tables();
    old.deals = [Object.fromEntries(Object.entries(deal(UGC, "Wordwise", false)).filter(([k]) => k !== "personal_brand")) as ReturnType<typeof deal>];
    current = fakeDb(old).db;
    expect((await listDeals({ now: NOW })).deals.map((d) => d.deal.brand_name)).toEqual(["Wordwise"]);
  });

  it("payoutMatches: a payer also confirmed for Personal Brand still teaches the UGC deal a rule (as the page does)", async () => {
    const { payoutMatches } = await import("@/lib/ugc/queries");
    const pay = (id: string, dealId: string, paidOn: string) => ({ id, deal_id: dealId, transaction_id: `t-${id}`, amount_cents: 5000, paid_on: paidOn });
    const tx = (id: string) => ({ id: `t-${id}`, name: "PAYPAL TRANSFER", amount_cents: 5000, posted_on: "2026-11-01", hidden: false, is_transfer: false });
    current = fakeDb({
      ...tables(),
      deal_payments: [pay("p1", UGC, "2026-10-01"), pay("p2", UGC, "2026-11-01"), pay("p3", PB, "2026-11-02")],
      transactions: [tx("p1"), tx("p2"), tx("p3")],
      payout_rules: [],
      payout_match_rejections: [],
    }).db;
    const { ruleOffers } = await payoutMatches({ now: NOW });
    expect(ruleOffers.map((o) => [o.brandName, o.confirmations])).toEqual([["Wordwise", 2]]);
  });
});
