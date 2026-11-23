import { describe, expect, it } from "vitest";

import { readLatestEngagement } from "@/lib/ugc/analytics-queries";
import type { Db } from "@/lib/ugc/writes";

import {
  analyticsPosts,
  cadence,
  consistency,
  earningsSeries,
  engagementTotals,
  inWindow,
  intensity,
  latestPosts,
  platformVideos,
  platformViews,
  resolveWindow,
  splitSeriesDelta,
  topVideos,
  trendDays,
  viewDistribution,
  viewsByDeal,
  viewsPerDay,
  weeksOf,
  type AnalyticsSource,
} from "./analytics";

// Hand fixture. Saturday Nov 21, 2026, 10:00 in Toronto. Every expected number below is worked out by hand.
const now = new Date("2026-11-21T15:00:00.000Z");
const zone = "America/Toronto";
const post = (id: string, deal: string, platform: "TIKTOK" | "INSTAGRAM" | "YOUTUBE", at: string, group: string | null, excluded = false) => ({
  id,
  deal_id: deal,
  platform,
  posted_at: at,
  video_group_id: group,
  exclude_from_pay: excluded,
});
const src: AnalyticsSource = {
  posts: [
    post("p1", "A", "TIKTOK", "2026-11-20T17:00:00.000Z", "g1"), // Nov 20, cross-posted with p2
    post("p2", "A", "INSTAGRAM", "2026-11-20T18:00:00.000Z", "g1"),
    post("p3", "A", "TIKTOK", "2026-11-18T17:00:00.000Z", null),
    post("p4", "B", "YOUTUBE", "2026-11-10T17:00:00.000Z", null), // no reading yet
    post("p5", "B", "TIKTOK", "2026-11-19T17:00:00.000Z", null, true), // excluded: in no block
    post("p6", "A", "INSTAGRAM", "2026-08-01T16:00:00.000Z", null), // latest reading held for review
  ],
  views: [
    { post_id: "p1", payable_views: 900, latest_views: 1000, latest_held: false },
    { post_id: "p2", payable_views: 300, latest_views: 300, latest_held: false },
    { post_id: "p3", payable_views: 50, latest_views: 50, latest_held: false },
    { post_id: "p4", payable_views: null, latest_views: null, latest_held: false },
    { post_id: "p5", payable_views: 9999, latest_views: 9999, latest_held: false },
    { post_id: "p6", payable_views: 150_000, latest_views: 2_000_000, latest_held: true },
  ],
  engagement: [
    { post_id: "p1", likes: 50, comments: 5 },
    { post_id: "p2", likes: 10, comments: null },
    { post_id: "p4", likes: 0, comments: 0 },
    { post_id: "p6", likes: 900, comments: 40 },
  ],
};
const deals = [
  { id: "A", name: "Alpha" },
  { id: "B", name: "Beta" },
];
const all = analyticsPosts(src, null);
const week = resolveWindow("1w", { now, zone })!;
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("inputs", () => {
  it("drops excluded posts, uses the payable count when the latest reading is held, and filters a deal", () => {
    expect(ids(all)).toEqual(["p1", "p2", "p3", "p4", "p6"]);
    expect(all.find((p) => p.id === "p6")!.views).toBe(150_000);
    expect(all.find((p) => p.id === "p4")!.views).toBe(0);
    expect(all.find((p) => p.id === "p3")!.likes).toBeNull();
    expect(ids(analyticsPosts(src, "B"))).toEqual(["p4"]);
  });

  it("drops every post of a group when one of them is excluded", () => {
    const s = { ...src, posts: src.posts.map((p) => (p.id === "p2" ? { ...p, exclude_from_pay: true } : p)) };
    expect(ids(analyticsPosts(s, null))).toEqual(["p3", "p4", "p6"]);
  });
});

describe("range (Ripple lib/dashboard/range.ts)", () => {
  it("presets are the trailing N x 24 h; all time has no lower bound", () => {
    expect(week.from!.toISOString()).toBe("2026-11-14T15:00:00.000Z");
    expect(resolveWindow("1d", { now, zone })!.from!.toISOString()).toBe("2026-11-20T15:00:00.000Z");
    expect(resolveWindow("all", { now, zone })).toEqual({ from: null, to: now });
  });

  it("custom spans whole days in the owner's zone; a missing or inverted bound is pending", () => {
    const w = resolveWindow("custom", { now, zone, customStart: "2026-11-01", customEnd: "2026-11-03" })!;
    expect(w.from!.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-11-04T04:59:59.999Z");
    expect(resolveWindow("custom", { now, zone, customStart: "2026-11-01" })).toBeNull();
    expect(resolveWindow("custom", { now, zone, customStart: "2026-11-05", customEnd: "2026-11-01" })).toBeNull();
  });

  it("the window keeps posts posted inside it", () => {
    expect(ids(inWindow(all, week))).toEqual(["p1", "p2", "p3"]);
  });
});

describe("views by deal (views-by-campaign route)", () => {
  it("1w: eight day rows, a deal with posts only, views on the posting day", () => {
    const v = viewsByDeal(all, deals, week, zone);
    expect(v.deals).toEqual([{ id: "A", name: "Alpha" }]);
    expect(v.days.map((d) => d.day)).toEqual(["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"]);
    expect(v.days.find((d) => d.day === "2026-11-20")!.values).toEqual([1300]);
    expect(v.days.find((d) => d.day === "2026-11-18")!.values).toEqual([50]);
    expect(v.days.reduce((s, d) => s + d.values[0], 0)).toBe(1350);
  });

  it("all time is the trailing 90 days and today; older posts fall off", () => {
    const v = viewsByDeal(all, deals, resolveWindow("all", { now, zone })!, zone);
    expect(v.days).toHaveLength(91);
    expect(v.days[0].day).toBe("2026-08-23");
    expect(v.deals.map((d) => d.id)).toEqual(["A", "B"]);
    expect(v.days.reduce((s, d) => s + d.values[0], 0)).toBe(1350);
  });
});

describe("engagement and trends", () => {
  it("sums views, likes and comments of the window's posts", () => {
    expect(engagementTotals(inWindow(all, week))).toEqual({ views: 1350, likes: 60, comments: 5, unread: 1 });
    expect(engagementTotals(all)).toEqual({ views: 151_350, likes: 960, comments: 45, unread: 1 });
  });

  it("posts and views per day on the window's day axis", () => {
    const days = trendDays(week, all, zone);
    expect(days).toHaveLength(8);
    const c = cadence(inWindow(all, week), days, zone);
    expect(c.filter((d) => d.posts > 0)).toEqual([
      { day: "2026-11-18", posts: 1 },
      { day: "2026-11-20", posts: 2 },
    ]);
    const v = viewsPerDay(inWindow(all, week), days, zone).find((d) => d.day === "2026-11-20")!;
    expect(v.total).toBe(1300);
    expect(v.byPlatform).toEqual({ INSTAGRAM: 300, TIKTOK: 1000, YOUTUBE: 0, FACEBOOK: 0 });
  });

  it("all time starts at the earliest post: Aug 1 to Nov 21 is 113 days", () => {
    const days = trendDays(resolveWindow("all", { now, zone })!, all, zone);
    expect(days[0]).toBe("2026-08-01");
    expect(days).toHaveLength(113);
  });

  it("earned cents land on their days, zero elsewhere", () => {
    expect(earningsSeries(new Map([["2026-11-20", 2500]]), ["2026-11-19", "2026-11-20"])).toEqual([
      { day: "2026-11-19", cents: 0 },
      { day: "2026-11-20", cents: 2500 },
    ]);
  });

  it("delta is the second half over the first (EngagementCard splitSeriesDelta)", () => {
    expect(splitSeriesDelta([1, 2, 3, 4])).toEqual({ direction: "up", deltaPct: 133 });
    expect(splitSeriesDelta([4, 2])).toEqual({ direction: "down", deltaPct: -50 });
    expect(splitSeriesDelta([0, 0, 5])).toEqual({ direction: "up", deltaPct: null });
    expect(splitSeriesDelta([7])).toEqual({ direction: "flat", deltaPct: null });
  });
});

describe("platform mix (content.ts)", () => {
  it("views per platform with whole-percent shares", () => {
    const v = platformViews(all);
    expect(v.total).toBe(151_350);
    expect(v.slices).toEqual([
      { platform: "INSTAGRAM", value: 150_300, pct: 99 },
      { platform: "TIKTOK", value: 1050, pct: 1 },
      { platform: "YOUTUBE", value: 0, pct: 0 },
      { platform: "FACEBOOK", value: 0, pct: 0 },
    ]);
  });

  it("videos per platform count a cross-post once per platform and once in all", () => {
    const v = platformVideos(all);
    expect(v.slices.map((s) => [s.platform, s.value, s.pct])).toEqual([
      ["INSTAGRAM", 2, 40],
      ["TIKTOK", 2, 40],
      ["YOUTUBE", 1, 20],
      ["FACEBOOK", 0, 0],
    ]);
    expect(v.total).toBe(4);
  });

  it("view distribution puts each post in one bucket", () => {
    expect(viewDistribution(all)).toEqual([
      { label: "0", count: 1 },
      { label: "1-100", count: 1 },
      { label: "100-1K", count: 1 },
      { label: "1K-10K", count: 1 },
      { label: "10K-100K", count: 0 },
      { label: "100K-1M", count: 1 },
      { label: "1M+", count: 0 },
    ]);
  });
});

describe("top videos and latest posts", () => {
  it("one row per video, the most viewed post of a group, by views or recency", () => {
    expect(ids(topVideos(all))).toEqual(["p6", "p1", "p3", "p4"]);
    expect(ids(topVideos(all, "recent"))).toEqual(["p1", "p3", "p4", "p6"]);
  });

  it("latest posts list every post, newest first", () => {
    expect(ids(latestPosts(all))).toEqual(["p2", "p1", "p3", "p4", "p6"]);
  });
});

describe("posting consistency", () => {
  it("counts platforms per day; the streak runs back from yesterday while today is empty", () => {
    const c = consistency(all, now, zone);
    expect(c.days).toHaveLength(365);
    expect(c.days.at(-1)!.date).toBe("2026-11-21");
    expect(c.days.find((d) => d.date === "2026-11-20")!.count).toBe(2);
    expect(c.totalPosts).toBe(5);
    expect(c.currentStreak).toBe(1);
    expect(c.longestStreak).toBe(1);
  });

  it("shades and weeks", () => {
    expect([0, 1, 2, 3, 4, 6].map(intensity)).toEqual([0, 1, 2, 2, 3, 4]);
    // Nov 18, 2026 is a Wednesday: three leading blanks.
    const w = weeksOf([{ date: "2026-11-18" }, { date: "2026-11-19" }]);
    expect(w).toEqual([[null, null, null, { date: "2026-11-18" }, { date: "2026-11-19" }, null, null]]);
  });
});

describe("readLatestEngagement", () => {
  it("reads one newest reading per post in one request, not the whole history", async () => {
    const requests: { table: string; calls: [string, ...unknown[]][] }[] = [];
    const rows = [
      { id: "p1", post_view_snapshots: [{ likes: "12", comments: 3 }] },
      { id: "p2", post_view_snapshots: [] },
      { id: "p3", post_view_snapshots: [{ likes: null, comments: "4" }] },
    ];
    const db = {
      from(table: string) {
        const req = { table, calls: [] as [string, ...unknown[]][] };
        requests.push(req);
        const chain: unknown = new Proxy(
          {},
          {
            get: (_t, prop: string) =>
              prop === "then"
                ? (res: (v: unknown) => unknown) => res({ data: rows, error: null })
                : (...args: unknown[]) => (req.calls.push([prop, ...args]), chain),
          },
        );
        return chain;
      },
    } as unknown as Db;

    expect(await readLatestEngagement(db)).toEqual([
      { post_id: "p1", likes: 12, comments: 3 },
      { post_id: "p3", likes: null, comments: 4 },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.table).toBe("posts");
    expect(requests[0]!.calls).toContainEqual(["limit", 1, { referencedTable: "post_view_snapshots" }]);
    expect(requests[0]!.calls).toContainEqual(["eq", "post_view_snapshots.held", false]);
  });
});
