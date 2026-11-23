/**
 * Personal Brand: the owner's own Instagram, read from the deals flagged `personal_brand` (0140) and the
 * follower counts in `personal_brand_followers` (typed, or synced from the connected Instagram account). Pure and client-safe; the per-post math is the UGC
 * analytics (src/lib/ugc/analytics.ts), reused as is.
 */
import { z } from "zod";

import {
  analyticsPosts,
  consistency,
  engagementTotals,
  inWindow,
  topVideos,
  type AnalyticsPost,
  type AnalyticsWindow,
  type EngagementRow,
} from "@/lib/ugc/analytics";
import { dayKeyInZone } from "@/lib/ugc/days";
import type { Platform } from "@/lib/ugc/schemas";

export interface BrandPostRaw {
  id: string;
  deal_id: string;
  platform: Platform;
  url: string;
  title: string | null;
  posted_at: string;
  video_group_id: string | null;
  exclude_from_pay: boolean;
}

export interface FollowerRow {
  day: string;
  followers: number;
  /** manual: typed; instagram: the Instagram sync (src/lib/instagram/sync.ts); sync: an older daily sync. */
  source: "manual" | "sync" | "instagram";
}

/** Today's follower count, as the owner types it (setFollowers). The server picks the day (owner zone). */
export const setFollowersSchema = z.object({
  followers: z.number().int().min(0).max(10_000_000_000),
});

/** Everything the page and the agent read. */
export interface BrandRaw {
  nowIso: string;
  zone: string;
  /** The deals flagged personal_brand (normally one). */
  deals: { id: string; brand_name: string }[];
  /** The Instagram handle of the account, when one is on the deal. */
  handle: string | null;
  posts: BrandPostRaw[];
  views: { post_id: string; payable_views: number | null; latest_views: number | null; latest_held: boolean }[];
  engagement: EngagementRow[];
  followers: FollowerRow[];
  /** Post id to its thumbnail URL (src/lib/brand/instagram-media.ts), for the posts that have one. */
  thumbs: Record<string, string>;
}

/**
 * Every post, with its latest views, likes and comments. `exclude_from_pay` is UGC pay logic; the owner's own
 * account has no pay, so a flagged post still shows here.
 */
export function brandPosts(raw: BrandRaw): AnalyticsPost[] {
  return analyticsPosts({ ...raw, posts: raw.posts.map((p) => ({ ...p, exclude_from_pay: false })) }, null);
}

/**
 * Likes plus comments per view, as a fraction, over the posts with a likes or comments reading (a post with no
 * reading would add its views and nothing else). Null while those posts have no views.
 */
export function engagementRate(posts: readonly AnalyticsPost[]): number | null {
  let views = 0;
  let acts = 0;
  for (const p of posts) {
    if (p.likes === null && p.comments === null) continue;
    views += p.views;
    acts += (p.likes ?? 0) + (p.comments ?? 0);
  }
  return views > 0 ? acts / views : null;
}

export interface FollowerStats {
  /** The readings inside the window, oldest first. */
  points: FollowerRow[];
  /** The newest reading overall. */
  latest: FollowerRow | null;
  /** Newest minus the reading the window started from (the last one before it, else its first). Null with fewer than two. */
  change: number | null;
}

/** Followers over a window. Day keys compare as strings (YYYY-MM-DD, owner zone). */
export function followerStats(rows: readonly FollowerRow[], win: AnalyticsWindow, zone: string): FollowerStats {
  const sorted = [...rows].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const from = win.from ? dayKeyInZone(win.from, zone) : null;
  const to = dayKeyInZone(win.to, zone);
  const points = sorted.filter((r) => (from === null || r.day >= from) && r.day <= to);
  const latest = sorted.at(-1) ?? null;
  const before = from === null ? undefined : sorted.filter((r) => r.day < from).at(-1);
  const base = before ?? points[0];
  const end = points.at(-1) ?? null;
  const change = base && end && base !== end ? end.followers - base.followers : null;
  return { points, latest, change };
}

/** Posts per week over the window's span (at least one week). */
export function postsPerWeek(count: number, win: AnalyticsWindow, posts: readonly AnalyticsPost[]): number {
  const start = win.from?.getTime() ?? Math.min(win.to.getTime(), ...posts.map((p) => Date.parse(p.postedAt)));
  const weeks = Math.max(1, (win.to.getTime() - start) / (7 * 86_400_000));
  return count / weeks;
}

/** What the agent reads (get_personal_brand): the page's numbers for one window. */
export function brandSummary(raw: BrandRaw, win: AnalyticsWindow) {
  const now = new Date(raw.nowIso);
  const all = brandPosts(raw);
  const inRange = inWindow(all, win);
  const totals = engagementTotals(inRange);
  const rate = engagementRate(inRange);
  const followers = followerStats(raw.followers, win, raw.zone);
  const year = consistency(all, now, raw.zone);
  const url = new Map(raw.posts.map((p) => [p.id, p]));
  const row = (p: AnalyticsPost) => ({
    url: url.get(p.id)?.url ?? null,
    title: url.get(p.id)?.title ?? null,
    postedDay: dayKeyInZone(new Date(p.postedAt), raw.zone),
    views: p.views,
    likes: p.likes,
    comments: p.comments,
  });
  return {
    handle: raw.handle,
    zone: raw.zone,
    window: { from: win.from?.toISOString() ?? null, to: win.to.toISOString() },
    followers: {
      latest: followers.latest?.followers ?? null,
      latestDay: followers.latest?.day ?? null,
      changeInRange: followers.change,
      readingsInRange: followers.points.length,
    },
    posts: inRange.length,
    postsAllTime: all.length,
    postsPerWeek: Math.round(postsPerWeek(inRange.length, win, all) * 10) / 10,
    views: totals.views,
    likes: totals.likes,
    comments: totals.comments,
    postsWithoutEngagementReading: totals.unread,
    engagementRatePct: rate === null ? null : Math.round(rate * 10_000) / 100,
    avgViewsPerPost: inRange.length ? Math.round(totals.views / inRange.length) : null,
    streakDays: year.currentStreak,
    longestStreakDays: year.longestStreak,
    topPosts: topVideos(inRange).slice(0, 5).map(row),
    recentPosts: [...all].sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt)).slice(0, 5).map(row),
  };
}
