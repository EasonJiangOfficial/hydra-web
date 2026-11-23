/**
 * Personal Brand thumbnails, matched from the account's own media list (src/lib/brand/instagram-media.ts).
 * Pure; the fetch lives in that server file. Meta's oEmbed stopped returning `thumbnail_url` on
 * 2025-11-03, so the account's media list is the source.
 */

/** Hosts Instagram serves media from (next.config.ts img-src lists the same). */
export const THUMB_HOSTS = [/\.cdninstagram\.com$/, /\.fbcdn\.net$/];

/** One item of GET graph.facebook.com/<ig id>/media (fields shortcode, permalink, media_type, media_url, thumbnail_url). */
export interface IgMedia {
  shortcode?: string;
  permalink?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
}

/** The post's shortcode from an Instagram post URL (/p/, /reel/, /reels/, /tv/), else null. */
export function shortcodeOf(url: string): string | null {
  return /^https?:\/\/(?:www\.)?instagram\.com\/(?:[\w.]+\/)?(?:p|reels?|tv)\/([\w-]+)/.exec(url)?.[1] ?? null;
}

/** A safe image URL: https on an Instagram CDN host. */
function cdnUrl(v: unknown): string | null {
  if (typeof v !== "string" || !URL.canParse(v)) return null;
  const u = new URL(v);
  return u.protocol === "https:" && THUMB_HOSTS.some((h) => h.test(u.hostname)) ? u.toString() : null;
}

/** Post id to thumbnail, for every post the media list has. A video's thumbnail_url; an image or album's media_url. */
export function matchThumbs(posts: readonly { id: string; url: string }[], media: readonly IgMedia[]): Record<string, string> {
  const byCode = new Map<string, string>();
  for (const m of media) {
    const code = m.shortcode ?? (m.permalink ? shortcodeOf(m.permalink) : null);
    const img = m.media_type === "VIDEO" ? cdnUrl(m.thumbnail_url) : (cdnUrl(m.media_url) ?? cdnUrl(m.thumbnail_url));
    if (code && img) byCode.set(code, img);
  }
  const out: Record<string, string> = {};
  for (const p of posts) {
    const img = byCode.get(shortcodeOf(p.url) ?? "");
    if (img) out[p.id] = img;
  }
  return out;
}
