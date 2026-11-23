import "server-only";
import { cacheLife } from "next/cache";

import { matchThumbs, type IgMedia } from "@/lib/brand/thumbs";
import { API } from "@/lib/instagram/client";
import { storedToken } from "@/lib/instagram/oauth";

/** Most pages read (100 posts each). */
const MAX_PAGES = 20;

/**
 * The account's media list, from the Instagram API with Unified Login (GET graph.facebook.com/<ig id>/media),
 * cached for hours (the CDN links expire). The token is part of the cache key, so a new sign-in reads afresh.
 * A network or server failure throws, so it is not cached; the caller shows neutral tiles this time.
 */
async function accountMedia(token: string, igUserId: string): Promise<IgMedia[]> {
  "use cache";
  cacheLife("hours");
  const q = new URLSearchParams({ fields: "shortcode,permalink,media_type,media_url,thumbnail_url", limit: "100", access_token: token });
  let next: string | undefined = `${API}/${encodeURIComponent(igUserId)}/media?${q}`;
  const out: IgMedia[] = [];
  for (let i = 0; next && i < MAX_PAGES; i++) {
    const res = await fetch(next, { signal: AbortSignal.timeout(5000) });
    if (res.status >= 500 || res.status === 429) throw new Error(`Instagram media ${res.status}`);
    if (!res.ok) return out;
    const body = (await res.json()) as { data?: IgMedia[]; paging?: { next?: string } };
    out.push(...(body.data ?? []));
    // Only follow a next page on the same API host (it carries the token).
    next = body.paging?.next?.startsWith("https://graph.facebook.com/") ? body.paging.next : undefined;
  }
  return out;
}

/**
 * Thumbnails for every post the account's media list has (one cached read covers the whole grid), with the
 * connected account's token (Settings > Connections); not connected, no thumbnails.
 */
export async function thumbsFor(posts: readonly { id: string; url: string }[]): Promise<Record<string, string>> {
  if (posts.length === 0) return {};
  const stored = await storedToken();
  if (!stored) return {};
  return matchThumbs(posts, await accountMedia(stored.token, stored.igUserId).catch(() => []));
}
