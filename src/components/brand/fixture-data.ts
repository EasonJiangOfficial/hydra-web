/**
 * Personal Brand fixture for /dev/brand and the e2e spec: one Instagram account, 64 posts over 20 weeks with
 * views, likes and comments, weekly follower counts, and stand-in thumbnails on every other post (the rest show
 * the neutral tile). Deterministic: the clock is fixed at Saturday, November 21, 2026 (Toronto).
 */
import type { BrandRaw, FollowerRow } from "@/lib/brand/model";
import { addDays, zonedDayStart } from "@/lib/ugc/days";

export const BRAND_NOW = "2026-11-21T15:00:00.000Z";
export const BRAND_ZONE = "America/Toronto";
const DEAL = "00000000-0000-4000-8000-000000000201";
const pid = (n: number) => `00000000-0000-4000-8000-${String(500 + n).padStart(12, "0")}`;

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A flat two-tone stand-in for a photo (data: URLs pass the page's CSP). */
function thumb(i: number): string {
  const tones = ["#d2d2d7", "#a1a1a6", "#6e6e73", "#424245", "#e5e5ea"];
  const a = tones[i % tones.length];
  const b = tones[(i + 2) % tones.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${a}"/><circle cx="${3 + (i % 5)}" cy="6" r="3.2" fill="${b}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function brandFixture(): BrandRaw {
  const rand = seeded(7);
  const posts: BrandRaw["posts"] = [];
  const views: BrandRaw["views"] = [];
  const engagement: BrandRaw["engagement"] = [];
  const thumbs: Record<string, string> = {};
  let day = "2026-07-04";
  for (let i = 0; i < 64; i++) {
    day = addDays(day, 1 + Math.floor(rand() * 3));
    if (day > "2026-11-20") break;
    const id = pid(i);
    const hour = 9 + Math.floor(rand() * 10);
    const postedAt = new Date(zonedDayStart(day, BRAND_ZONE).getTime() + hour * 3_600_000).toISOString();
    const v = Math.round(800 + rand() ** 3 * 90_000);
    posts.push({
      id,
      deal_id: DEAL,
      platform: "INSTAGRAM",
      url: `https://www.instagram.com/reel/Fx${String(i).padStart(3, "0")}/`,
      title: i % 4 === 0 ? `Day in the life ${i / 4 + 1}` : null,
      posted_at: postedAt,
      video_group_id: null,
      exclude_from_pay: false,
    });
    views.push({ post_id: id, payable_views: v, latest_views: v, latest_held: false });
    // The newest post has no likes reading yet.
    if (day < "2026-11-20") engagement.push({ post_id: id, likes: Math.round(v * (0.03 + rand() * 0.04)), comments: Math.round(v * (0.002 + rand() * 0.004)) });
    if (i % 2 === 0) thumbs[id] = thumb(i);
  }
  const followers: FollowerRow[] = [];
  let count = 1840;
  for (let d = "2026-07-04"; d <= "2026-11-20"; d = addDays(d, 7)) {
    count += Math.round(20 + rand() * 90);
    followers.push({ day: d, followers: count, source: "manual" });
  }
  return { nowIso: BRAND_NOW, zone: BRAND_ZONE, deals: [{ id: DEAL, brand_name: "Personal Brand" }], handle: "studio.notes", posts, views, engagement, followers, thumbs };
}
