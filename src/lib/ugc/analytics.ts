/**
 * UGC analytics: the blocks of Ripple's creator dashboard (app/dashboard/page.tsx), computed from Hydra's rows.
 * Pure and client-safe. Each formula cites the Ripple file:line it ports. Money comes from the ledger
 * (earned cents per day are passed in); nothing here prices a video.
 *
 * Hydra differences, on purpose:
 * - Days are the owner's zone, not UTC.
 * - Excluded videos are left out of every block (the owner excludes a video when it should not count).
 * - A post's views are its latest trusted reading: the latest one, or the last payable one when the
 *   latest is held for review (Ripple has no held readings).
 */
import { addDays, dayKeyInZone, dayKeysBetween, zonedDayStart } from "@/lib/ugc/days";
import { buildConsistencyResponse, type ConsistencyResponse } from "@/lib/ugc/posting-consistency";
import { PLATFORMS, type Platform } from "@/lib/ugc/schemas";

const DAY_MS = 86_400_000;

// ─── Range ───────────────────────────────────────────────────────────────────

/** Ripple lib/dashboard/range.ts:24 (DASHBOARD_RANGE_TABS). */
export const RANGE_KEYS = ["1d", "1w", "2w", "1m", "all", "custom"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];
export const RANGE_LABEL: Record<RangeKey, string> = {
  "1d": "1d",
  "1w": "1w",
  "2w": "2w",
  "1m": "1m",
  all: "All time",
  custom: "Custom",
};
/** Ripple lib/dashboard/range.ts:39. */
const PRESET_DAYS = { "1d": 1, "1w": 7, "2w": 14, "1m": 30 } as const;

export function isRangeKey(v: string | null | undefined): v is RangeKey {
  return RANGE_KEYS.some((k) => k === v);
}

/** A posted-at window. `from: null` is All time (no lower bound). */
export interface AnalyticsWindow {
  from: Date | null;
  to: Date;
}

/**
 * Ripple lib/dashboard/range.ts:72 (resolveDashboardWindow): presets are the trailing N x 24 h up to now; custom
 * is two day keys, the end inclusive of its whole day (Ripple app/api/dashboard/views-by-campaign/route.ts:89),
 * here in the owner's zone. Null while a custom pick is missing a bound or is inverted.
 */
export function resolveWindow(
  range: RangeKey,
  opts: { now: Date; zone: string; customStart?: string | null; customEnd?: string | null },
): AnalyticsWindow | null {
  if (range === "all") return { from: null, to: opts.now };
  if (range === "custom") {
    const { customStart: a, customEnd: b } = opts;
    if (!a || !b || a > b) return null;
    return { from: zonedDayStart(a, opts.zone), to: new Date(zonedDayStart(addDays(b, 1), opts.zone).getTime() - 1) };
  }
  return { from: new Date(opts.now.getTime() - PRESET_DAYS[range] * DAY_MS), to: opts.now };
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** One post as the analytics read it (one row per account post, like Ripple's PlatformPost). */
export interface AnalyticsPost {
  id: string;
  dealId: string;
  platform: Platform;
  postedAt: string;
  /** `video_group_id`, or null for a post on one account only (Ripple's unifiedVideoId). */
  groupId: string | null;
  views: number;
  likes: number | null;
  comments: number | null;
}

/** The latest trusted likes and comments of a post (from `post_view_snapshots`). */
export interface EngagementRow {
  post_id: string;
  likes: number | null;
  comments: number | null;
}

/** The page's rows may carry the engagement read (src/app/(app)/ugc/data.ts and the fixture add it). */
export type WithEngagement = { engagement?: readonly EngagementRow[] };

/** The rows the analytics need from the tracker's raw data. */
export interface AnalyticsSource {
  posts: readonly {
    id: string;
    deal_id: string;
    platform: Platform;
    posted_at: string;
    video_group_id: string | null;
    exclude_from_pay: boolean;
  }[];
  views: readonly { post_id: string; payable_views: number | null; latest_views: number | null; latest_held: boolean }[];
  engagement?: readonly EngagementRow[];
}

/** The posts of one deal (or all), excluded videos left out. A group with any excluded post is excluded. */
export function analyticsPosts(src: AnalyticsSource, dealId: string | null): AnalyticsPost[] {
  const view = new Map(src.views.map((v) => [v.post_id, v]));
  const eng = new Map((src.engagement ?? []).map((e) => [e.post_id, e]));
  const excludedGroups = new Set(src.posts.filter((p) => p.exclude_from_pay && p.video_group_id).map((p) => `${p.deal_id}|${p.video_group_id}`));
  const num = (v: number | null | undefined) => (v === null || v === undefined ? null : Number(v));
  return src.posts
    .filter((p) => (dealId === null || p.deal_id === dealId) && !p.exclude_from_pay)
    .filter((p) => !(p.video_group_id && excludedGroups.has(`${p.deal_id}|${p.video_group_id}`)))
    .map((p) => {
      const v = view.get(p.id);
      const views = v ? (v.latest_held ? num(v.payable_views) : num(v.latest_views)) : null;
      const e = eng.get(p.id);
      return {
        id: p.id,
        dealId: p.deal_id,
        platform: p.platform,
        postedAt: p.posted_at,
        groupId: p.video_group_id,
        views: views ?? 0,
        likes: num(e?.likes),
        comments: num(e?.comments),
      };
    });
}

/** Posts inside the window (Ripple filters `postedAt` gte from, lte to). */
export function inWindow<T extends Pick<AnalyticsPost, "postedAt">>(posts: readonly T[], win: AnalyticsWindow): T[] {
  return posts.filter((p) => {
    const t = Date.parse(p.postedAt);
    return (win.from === null || t >= win.from.getTime()) && t <= win.to.getTime();
  });
}

// ─── Day axes ────────────────────────────────────────────────────────────────

/** Most days the views-by-deal grid spans. Ripple app/api/dashboard/views-by-campaign/route.ts:33. */
export const MAX_GRID_DAYS = 366;
/** All time on the views-by-deal chart is the trailing 90 days. Ripple app/dashboard/page.tsx:624. */
export const ALL_TIME_GRID_DAYS = 90;

/**
 * The views-by-deal day grid. Ripple app/api/dashboard/views-by-campaign/route.ts:99-110 and :187-201: a window
 * spans [day(from) .. day(to)], clamped to the last 366 days; All time is the trailing 90 days and today (91 rows).
 */
export function viewsGridDays(win: AnalyticsWindow, zone: string): string[] {
  const end = dayKeyInZone(win.to, zone);
  if (win.from === null) return dayKeysBetween(addDays(end, -ALL_TIME_GRID_DAYS), end);
  const start = dayKeyInZone(win.from, zone);
  const floor = addDays(end, -MAX_GRID_DAYS);
  return dayKeysBetween(start < floor ? floor : start, end);
}

/**
 * The trend day axis (cadence, views per day, earnings). Ripple lib/community/dashboard/trends.ts:101
 * (dayKeysInRange); All time starts at the earliest post (Ripple app/api/dashboard/analytics-bands/route.ts:136-151),
 * or the last 30 days when there is none (its 30d fallback).
 */
export function trendDays(win: AnalyticsWindow, posts: readonly Pick<AnalyticsPost, "postedAt">[], zone: string): string[] {
  const end = dayKeyInZone(win.to, zone);
  let from = win.from;
  if (from === null) {
    const first = posts.reduce<number | null>((m, p) => (m === null || Date.parse(p.postedAt) < m ? Date.parse(p.postedAt) : m), null);
    from = first === null ? new Date(win.to.getTime() - 30 * DAY_MS) : new Date(first);
  }
  const start = dayKeyInZone(from, zone);
  return start > end ? [end] : dayKeysBetween(start, end);
}

// ─── Views over time, by deal ────────────────────────────────────────────────

export interface ViewsByDeal {
  deals: { id: string; name: string }[];
  /** One row per grid day; `values[i]` belongs to `deals[i]`. */
  days: { day: string; values: number[] }[];
}

/**
 * Views by deal per posting day. Ripple app/api/dashboard/views-by-campaign/route.ts:165-212: each post's view
 * count lands on its posting day under its campaign, summed, zero-filled for every grid day. Deals with no
 * post in the window are left out (Ripple builds its series from the posts it found).
 */
export function viewsByDeal(
  posts: readonly AnalyticsPost[],
  deals: readonly { id: string; name: string }[],
  win: AnalyticsWindow,
  zone: string,
): ViewsByDeal {
  const grid = viewsGridDays(win, zone);
  // Ripple floors the start to its day (route.ts:99), so the whole first grid day counts.
  const rows = inWindow(posts, { from: zonedDayStart(grid[0], zone), to: win.to });
  const agg = new Map<string, number>();
  const seen = new Set<string>();
  for (const p of rows) {
    const key = `${dayKeyInZone(new Date(p.postedAt), zone)}|${p.dealId}`;
    agg.set(key, (agg.get(key) ?? 0) + p.views);
    seen.add(p.dealId);
  }
  const shown = deals.filter((d) => seen.has(d.id));
  return {
    deals: shown.map((d) => ({ id: d.id, name: d.name })),
    days: grid.map((day) => ({ day, values: shown.map((d) => agg.get(`${day}|${d.id}`) ?? 0) })),
  };
}

// ─── Trend series ────────────────────────────────────────────────────────────

/** Posts per day. Ripple lib/community/dashboard/trends.ts:525 (buildCadence). */
export function cadence(posts: readonly AnalyticsPost[], days: readonly string[], zone: string): { day: string; posts: number }[] {
  const by = new Map(days.map((d) => [d, 0]));
  for (const p of posts) {
    const k = dayKeyInZone(new Date(p.postedAt), zone);
    if (by.has(k)) by.set(k, by.get(k)! + 1);
  }
  return days.map((day) => ({ day, posts: by.get(day) ?? 0 }));
}

/** Views per posting day, by platform and in total. Ripple lib/community/dashboard/trends.ts:496 (buildViewsByPlatform). */
export function viewsPerDay(
  posts: readonly AnalyticsPost[],
  days: readonly string[],
  zone: string,
): { day: string; total: number; byPlatform: Record<Platform, number> }[] {
  const by = new Map(days.map((d) => [d, { day: d, total: 0, byPlatform: zeroPlatforms() }]));
  for (const p of posts) {
    const point = by.get(dayKeyInZone(new Date(p.postedAt), zone));
    if (!point) continue;
    point.byPlatform[p.platform] += p.views;
    point.total += p.views;
  }
  return days.map((d) => by.get(d)!);
}

/**
 * Earned cents per posting day over the axis. Ripple lib/community/dashboard/trends.ts:618 (buildEarnings: a
 * cross-posted video pays once on its day). Hydra takes the cents from the ledger (`earnedByDay`), which already
 * pays a group once, drops excluded videos and keeps each post's rate snapshot.
 */
export function earningsSeries(earnedByDay: ReadonlyMap<string, number>, days: readonly string[]): { day: string; cents: number }[] {
  return days.map((day) => ({ day, cents: earnedByDay.get(day) ?? 0 }));
}

/**
 * Change of the second half of a series over the first. Ripple app/dashboard/EngagementCard.tsx:114
 * (splitSeriesDelta): null percent when the first half is 0.
 */
export function splitSeriesDelta(series: readonly number[]): { direction: "up" | "down" | "flat"; deltaPct: number | null } {
  if (series.length < 2) return { direction: "flat", deltaPct: null };
  const half = Math.floor(series.length / 2);
  const previous = series.slice(0, half).reduce((a, b) => a + b, 0);
  const current = series.slice(half).reduce((a, b) => a + b, 0);
  if (previous === 0) return { direction: current > 0 ? "up" : "flat", deltaPct: null };
  return {
    direction: current > previous ? "up" : current < previous ? "down" : "flat",
    deltaPct: Math.round(((current - previous) / previous) * 100),
  };
}

// ─── Engagement ──────────────────────────────────────────────────────────────

export interface EngagementTotals {
  views: number;
  likes: number;
  comments: number;
  /** Posts with no likes or comments reading at all. */
  unread: number;
}

/** Sums over the window's posts. Ripple app/api/dashboard/route.ts:769-771 (_sum of viewCount, likeCount, commentCount). */
export function engagementTotals(posts: readonly AnalyticsPost[]): EngagementTotals {
  let views = 0;
  let likes = 0;
  let comments = 0;
  let unread = 0;
  for (const p of posts) {
    views += p.views;
    likes += p.likes ?? 0;
    comments += p.comments ?? 0;
    if (p.likes === null && p.comments === null) unread++;
  }
  return { views, likes, comments, unread };
}

// ─── Platform mix ────────────────────────────────────────────────────────────

/** Ripple lib/community/dashboard/content.ts:73 (pctOf). */
function pctOf(part: number, total: number): number {
  return total <= 0 ? 0 : Math.round((part / total) * 100);
}

function zeroPlatforms(): Record<Platform, number> {
  return Object.fromEntries(PLATFORMS.map((p) => [p, 0])) as Record<Platform, number>;
}

export interface PlatformSlice {
  platform: Platform;
  value: number;
  pct: number;
}

/** Views per platform and their share. Ripple lib/community/dashboard/content.ts:441 (buildPlatformViews). */
export function platformViews(posts: readonly AnalyticsPost[]): { slices: PlatformSlice[]; total: number } {
  const views = zeroPlatforms();
  let total = 0;
  for (const p of posts) {
    views[p.platform] += p.views;
    total += p.views;
  }
  return { slices: PLATFORMS.map((platform) => ({ platform, value: views[platform], pct: pctOf(views[platform], total) })), total };
}

/**
 * Videos per platform, a cross-posted video once per platform, and the combined count once in all.
 * Ripple lib/community/dashboard/content.ts:477 (buildPlatformVideos). Shares are of the per-platform sum.
 */
export function platformVideos(posts: readonly AnalyticsPost[]): { slices: PlatformSlice[]; total: number } {
  const groups = new Map<Platform, Set<string>>(PLATFORMS.map((p) => [p, new Set<string>()]));
  const single = zeroPlatforms();
  const allGroups = new Set<string>();
  let allSingle = 0;
  for (const p of posts) {
    if (p.groupId) {
      groups.get(p.platform)!.add(`${p.dealId}|${p.groupId}`);
      allGroups.add(`${p.dealId}|${p.groupId}`);
    } else {
      single[p.platform]++;
      allSingle++;
    }
  }
  const counts = PLATFORMS.map((p) => groups.get(p)!.size + single[p]);
  const sum = counts.reduce((a, b) => a + b, 0);
  return {
    slices: PLATFORMS.map((platform, i) => ({ platform, value: counts[i], pct: pctOf(counts[i], sum) })),
    total: allGroups.size + allSingle,
  };
}

/** Ripple lib/community/dashboard/content.ts:58 (VIEW_BUCKETS): min inclusive, max exclusive, the last open. */
export const VIEW_BUCKETS = [
  { label: "0", min: 0, max: 1 },
  { label: "1-100", min: 1, max: 100 },
  { label: "100-1K", min: 100, max: 1_000 },
  { label: "1K-10K", min: 1_000, max: 10_000 },
  { label: "10K-100K", min: 10_000, max: 100_000 },
  { label: "100K-1M", min: 100_000, max: 1_000_000 },
  { label: "1M+", min: 1_000_000, max: null },
] as const;

/** Posts per view bucket, every bucket present. Ripple lib/community/dashboard/content.ts:528 (buildViewDistribution). */
export function viewDistribution(posts: readonly AnalyticsPost[]): { label: string; count: number }[] {
  const counts = VIEW_BUCKETS.map(() => 0);
  for (const p of posts) {
    const i = VIEW_BUCKETS.findIndex((b) => p.views >= b.min && (b.max === null || p.views < b.max));
    if (i >= 0) counts[i]++;
  }
  return VIEW_BUCKETS.map((b, i) => ({ label: b.label, count: counts[i] }));
}

// ─── Top videos and recent posts ─────────────────────────────────────────────

/** Ripple lib/community/dashboard/content.ts:556 (TOP_VIDEOS_DEFAULT_LIMIT is 5, "Show more" adds batches). */
export const TOP_VIDEOS_PAGE = 5;
/** Ripple lib/community/dashboard/latest-posts.ts:39. */
export const LATEST_POSTS_PAGE = 10;

/**
 * One row per video: the most viewed post of a group stands for it. Sorted by views (newer first on a tie,
 * then id), or by recency. Ripple lib/community/dashboard/content.ts:310 (rankDedupedVideos) and :348
 * (orderRankedByRecency).
 */
export function topVideos(posts: readonly AnalyticsPost[], sort: "views" | "recent" = "views"): AnalyticsPost[] {
  const best = new Map<string, AnalyticsPost>();
  for (const p of posts) {
    const key = p.groupId ? `g:${p.dealId}|${p.groupId}` : `p:${p.id}`;
    const prev = best.get(key);
    if (!prev || p.views > prev.views) best.set(key, p);
  }
  const at = (p: AnalyticsPost) => Date.parse(p.postedAt);
  const ranked = [...best.values()].sort((a, b) => b.views - a.views || at(b) - at(a) || (a.id < b.id ? -1 : 1));
  return sort === "recent" ? [...ranked].sort((a, b) => at(b) - at(a) || (a.id < b.id ? -1 : 1)) : ranked;
}

/** Every post, newest first, id on a tie. Ripple lib/community/dashboard/latest-posts.ts:48 (LATEST_POSTS_ORDER_BY). */
export function latestPosts(posts: readonly AnalyticsPost[]): AnalyticsPost[] {
  return [...posts].sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt) || (a.id < b.id ? -1 : 1));
}

// ─── Posting consistency ─────────────────────────────────────────────────────

/** Ripple app/api/dashboard/posting-consistency/route.ts:7 (365 days, ending today). */
export const CONSISTENCY_DAYS = 365;

/** The year heatmap and streaks (Ripple buildConsistencyResponse, ported in posting-consistency.ts). */
export function consistency(posts: readonly AnalyticsPost[], now: Date, zone: string): ConsistencyResponse {
  const today = dayKeyInZone(now, zone);
  const since = zonedDayStart(addDays(today, -(CONSISTENCY_DAYS - 1)), zone);
  return buildConsistencyResponse(
    posts.map((p) => ({ postedAt: new Date(p.postedAt), platform: p.platform })),
    since,
    now,
    CONSISTENCY_DAYS,
    zone,
  );
}

/** Weeks of the heatmap, Sunday first; days outside the window are null. Ripple components/dashboard/ConsistencyHeatmap.tsx:189. */
export function weeksOf<T extends { date: string }>(days: readonly T[]): (T | null)[][] {
  if (days.length === 0) return [];
  const [y, m, d] = days[0].date.split("-").map(Number);
  const lead = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const cells: (T | null)[] = [...Array<null>(lead).fill(null), ...days];
  while (cells.length % 7) cells.push(null);
  const weeks: (T | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Heatmap shade for a day's count of platforms. Ripple components/dashboard/ConsistencyHeatmap.tsx:152 (0, 1, 2-3, 4-5, 6+). */
export function intensity(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 5) return 3;
  return 4;
}
