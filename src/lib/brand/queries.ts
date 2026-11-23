// No `import "server-only"`: vitest cannot resolve that bare id (see src/lib/ugc/writes.ts). Callers
// (the /brand page, the agent's get_personal_brand) run on the server.
import type { PostgrestError } from "@supabase/supabase-js";

import type { BrandPostRaw, BrandRaw, FollowerRow } from "@/lib/brand/model";
import { readLatestEngagement } from "@/lib/ugc/analytics-queries";
import { dayKeyInZone } from "@/lib/ugc/days";
import type { ActionResult } from "@/lib/ugc/schemas";
import { dbFail, fail, ok, zoneOf, type Db } from "@/lib/ugc/writes";

/**
 * Save today's follower count (the owner's zone, worked out here, never taken from the page). A second typed
 * count that day replaces the first; a 'sync' count for the day is kept, not overwritten. An 'instagram' count
 * stays editable: Instagram's value wins for the days it syncs, so the next sync that day writes it again.
 */
export async function saveFollowerCount(db: Db, followers: number, now: Date = new Date()): Promise<ActionResult<{ day: string; followers: number }>> {
  const day = dayKeyInZone(now, await zoneOf(db));
  const { data: existing, error: readError } = await db.from("personal_brand_followers").select("source").eq("day", day).maybeSingle();
  if (readError) return dbFail(readError);
  if ((existing as { source: string } | null)?.source === "sync") return fail("conflict", "Today's count was already synced");
  const { error } = await db.from("personal_brand_followers").upsert({ day, followers, source: "manual" }, { onConflict: "day" });
  if (error) return dbFail(error);
  return ok({ day, followers });
}

const PAGE = 1000;

type Page = PromiseLike<{ data: unknown[] | null; error: PostgrestError | null }>;

async function selectAll<T>(page: (from: number, to: number) => Page): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`Personal Brand read failed: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

/**
 * The Personal Brand rows, read as the caller (RLS: the owner, or hydra_ro). Thumbnails are not read here
 * (the page adds them). Likes and comments are an extra: a failed read leaves them empty.
 */
export async function loadBrandRaw(db: Db, now: Date = new Date()): Promise<BrandRaw> {
  const [zone, deals, followers] = await Promise.all([
    zoneOf(db),
    selectAll<{ id: string; brand_name: string }>((a, b) =>
      db.from("deals").select("id, brand_name").eq("personal_brand", true).order("id").range(a, b),
    ),
    selectAll<{ day: string; followers: number | string; source: FollowerRow["source"] }>((a, b) =>
      db.from("personal_brand_followers").select("day, followers, source").order("day").range(a, b),
    ),
  ]);
  const ids = deals.map((d) => d.id);
  const base = { nowIso: now.toISOString(), zone, deals, thumbs: {} };
  const counts = followers.map((f) => ({ ...f, followers: Number(f.followers) }));
  if (ids.length === 0) return { ...base, handle: null, posts: [], views: [], engagement: [], followers: counts };

  const [posts, views, accounts, engagement] = await Promise.all([
    selectAll<BrandPostRaw>((a, b) =>
      db
        .from("posts")
        .select("id, deal_id, platform, url, title, posted_at, video_group_id, exclude_from_pay")
        .in("deal_id", ids)
        .order("id")
        .range(a, b),
    ),
    selectAll<BrandRaw["views"][number]>((a, b) =>
      db.from("ugc_post_views").select("post_id, payable_views, latest_views, latest_held").in("deal_id", ids).order("post_id").range(a, b),
    ),
    selectAll<{ platform: string; handle: string }>((a, b) =>
      db.from("deal_accounts").select("platform, handle").in("deal_id", ids).order("id").range(a, b),
    ),
    readLatestEngagement(db, ids).catch(() => []),
  ]);
  const handle = (accounts.find((a) => a.platform === "INSTAGRAM") ?? accounts[0])?.handle ?? null;
  return { ...base, handle, posts, views, engagement, followers: counts };
}
