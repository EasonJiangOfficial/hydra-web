import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptToken, TokenDecryptError } from "@/lib/bank/crypto";
import { shortcodeOf } from "@/lib/brand/thumbs";
import { createAdminClient } from "@/lib/supabase/admin";
import { dayKeyInZone } from "@/lib/ugc/days";
import { normalizePostUrl } from "@/lib/ugc/schemas";
import { zoneOf } from "@/lib/ugc/writes";
import { INSTAGRAM_SCOPES, InstagramError, mediaInsights, profile, recentMedia, type Media } from "./client";
import { loadConnection, TABLE, type SealedConnection } from "./oauth";

/**
 * The Instagram sync, for the daily cron and the Sync now button. One run:
 * 1. takes the lease (sync_started_at, a compare-and-set), so two runs never overlap; a lease older than
 *    LEASE_MS is a run that died and is taken over;
 * 2. reads the sealed token (no refresh: the Unified login token never expires by default; one with an expiry
 *    needs a new sign-in once it passes);
 * 3. writes today's follower count (owner zone) with source 'instagram', replacing that day's row;
 * 4. upserts the media of the last 120 days as posts on the Personal Brand deal (made when none exists), keyed
 *    by the media's shortcode, so a rerun never adds a post twice;
 * 5. upserts today's views, likes and comments per post (one reading per post and day).
 * Every write is an upsert on a unique key, so a retry after a partial run, or a run after one that died, adds
 * nothing twice, and nothing here deletes. A run writes the connection row only while it still holds the token it
 * read (token_id, a non-secret marker: a reconnect mid-run wins), and frees only its own lease.
 *
 * last_error reauth_required (the page shows Reconnect, and syncs stop until a sign-in) comes only from a token
 * error (Graph 190, 102, 401, an unreadable or expired token) or a permission refusal of the account's own
 * profile read. A throttle stops the run and keeps what it wrote, and the next hour asks no
 * more. One post's refused insights read, whatever its code (Graph #10 too: a media with few viewers), is only
 * that post's: no reading for it today, and the run still syncs. A sync that missed something still counts as
 * synced, with soft notes in last_error (a comma-separated set) the page explains: insights_partial (some insights
 * reads failed), insights_refused (every post's read was refused for a permission: a grant taken back looks like
 * this, and so do only low-reach posts, so Settings offers Reconnect without a sign-out), insights_not_granted (the
 * sign-in did not grant insights: none are read, profile and posts still sync), media_cut (the page cap left
 * window media unread).
 */

const LEASE_MS = 10 * 60_000;
const WINDOW_DAYS = 120;
/** After Instagram throttles, wait this long before asking again. */
const BACKOFF_MS = 60 * 60_000;
const PARALLEL = 4;
const PAGE = 1000;

// ponytail: 'every post refused' only suggests a taken-back grant when there are a few posts; one or two low-reach
// posts (#10, not enough viewers) are refused for reach alone. Tune if a real revoked grant shows fewer posts.
const MIN_REFUSED_FOR_GRANT = 3;

export interface SyncResult {
  username: string;
  day: string;
  followers: number | null;
  media: number;
  postsAdded: number;
  readings: number;
  /** Media left out: no shortcode or URL, a post already on a UGC deal, or no views for it (none, or not granted). */
  skipped: number;
  /** Posts whose insights read Instagram refused (not in `skipped`). */
  insightsFailed: number;
  /** Every post's insights read was refused for a permission (Graph 10 or 200-299). */
  insightsRefused: boolean;
  /** The media page cap stopped the read with older media in the window left unread. */
  cut: boolean;
  /** The sign-in granted insights (an empty scope list is one Instagram did not report: taken as granted). */
  insightsGranted: boolean;
}

/** A finished run's soft notes, as last_error stores them (a comma-separated set), or null for a clean sync. */
const notesOf = (r: SyncResult) =>
  [r.insightsRefused ? "insights_refused" : r.insightsFailed > 0 && "insights_partial", !r.insightsGranted && "insights_not_granted", r.cut && "media_cut"].filter(Boolean).join(",") || null;

const fail = (what: string, error: { message: string }) => new Error(`instagram sync ${what}: ${error.message}`);

/**
 * The connection row, filtered to this run's token by its token_id (never the sealed token: a filter rides in the
 * request URL): a reconnect mid-run replaced it, so the run's writes miss.
 */
const ours = (db: SupabaseClient, conn: SealedConnection, patch: Record<string, unknown>) =>
  db.from(TABLE).update(patch).eq("id", conn.id).eq("token_id", conn.token_id);

/** Claim the run. False when another run holds a live lease. */
async function claim(db: SupabaseClient, id: string, now: Date): Promise<boolean> {
  const stale = await db.from(TABLE).update({ sync_started_at: null }).eq("id", id).lt("sync_started_at", new Date(now.getTime() - LEASE_MS).toISOString());
  if (stale.error) throw fail("lease", stale.error);
  const { data, error } = await db.from(TABLE).update({ sync_started_at: now.toISOString() }).eq("id", id).is("sync_started_at", null).select("id");
  if (error) throw fail("lease", error);
  return ((data ?? []) as unknown[]).length === 1;
}

export async function syncInstagram(db: SupabaseClient = createAdminClient(), now: Date = new Date()): Promise<SyncResult> {
  const conn = await loadConnection(db);
  if (!conn) throw new InstagramError("not_connected", "Connect Instagram first");
  if (conn.last_error === "reauth_required") throw new InstagramError("reauth_required", "Connect Instagram again");
  if (conn.last_error === "rate_limited" && now.getTime() - Date.parse(conn.updated_at) < BACKOFF_MS) {
    throw new InstagramError("rate_limited", "Instagram asked Hydra to slow down. Try again later.");
  }
  if (!(await claim(db, conn.id, now))) throw new InstagramError("busy", "A sync is already running");
  // Free only this run's lease: a run that outlived LEASE_MS was taken over, and the new lease is not ours.
  const release = () => db.from(TABLE).update({ sync_started_at: null }).eq("id", conn.id).eq("sync_started_at", now.toISOString());
  try {
    const result = await syncBody(db, conn, now);
    const { error } = await ours(db, conn, { last_synced_at: now.toISOString(), last_error: notesOf(result) });
    if (error) throw fail("finish", error);
    return result;
  } catch (e) {
    // An unreadable token (HYDRA_TOKEN_KEY changed) needs a new sign-in, as run() tells the caller.
    const code = e instanceof InstagramError ? e.code : e instanceof TokenDecryptError ? "reauth_required" : "internal";
    await ours(db, conn, { last_error: code });
    throw e;
  } finally {
    await release();
  }
}

/** The sealed token, unless it has expired (null expires_at: never). */
function liveToken(conn: SealedConnection, now: Date): string {
  if (conn.expires_at !== null && Date.parse(conn.expires_at) <= now.getTime()) {
    throw new InstagramError("reauth_required", "The Instagram token expired. Connect again.");
  }
  return decryptToken(conn.access_token, conn.id);
}

/** The Personal Brand deal (the oldest flagged one; made when none exists) and the account row for this username. */
async function brandDeal(db: SupabaseClient, username: string, day: string): Promise<{ dealId: string; dealIds: string[]; accountId: string }> {
  const found = await db.from("deals").select("id").eq("personal_brand", true).order("created_at").order("id");
  if (found.error) throw fail("deal", found.error);
  let dealIds = ((found.data ?? []) as { id: string }[]).map((d) => d.id);
  if (dealIds.length === 0) {
    const made = await db.from("deals").insert({ brand_name: "Personal Brand", start_date: day, personal_brand: true }).select("id").single();
    if (made.error) throw fail("deal", made.error);
    dealIds = [(made.data as { id: string }).id];
  }
  const account = await db
    .from("deal_accounts")
    .upsert({ deal_id: dealIds[0], platform: "INSTAGRAM", handle: username.toLowerCase() }, { onConflict: "deal_id,platform,handle" })
    .select("id")
    .single();
  if (account.error) throw fail("account", account.error);
  return { dealId: dealIds[0], dealIds, accountId: (account.data as { id: string }).id };
}

/**
 * Every Instagram post, by shortcode: the Personal Brand one (`pb`), else the first on another deal. A shortcode on
 * a UGC deal only is skipped, whatever its URL form (/p/, /reel/, /<user>/reel/).
 */
async function postsByCode(db: SupabaseClient, dealIds: string[]): Promise<Map<string, { id: string; pb: boolean }>> {
  const out = new Map<string, { id: string; pb: boolean }>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from("posts").select("id, url, deal_id").eq("platform", "INSTAGRAM").order("id").range(from, from + PAGE - 1);
    if (error) throw fail("posts", error);
    const rows = (data ?? []) as { id: string; url: string; deal_id: string }[];
    for (const r of rows) {
      const code = shortcodeOf(r.url);
      const pb = dealIds.includes(r.deal_id);
      if (code && (pb || !out.has(code))) out.set(code, { id: r.id, pb });
    }
    if (rows.length < PAGE) return out;
  }
}

/** A new post on the deal for one media. Null when its exact URL is already on a UGC deal (a race past postsByCode). */
async function ensurePost(db: SupabaseClient, m: Media, url: string, deal: { dealId: string; dealIds: string[]; accountId: string }): Promise<string | null> {
  const made = await db
    .from("posts")
    .insert({ deal_id: deal.dealId, account_id: deal.accountId, platform: "INSTAGRAM", url, posted_at: m.postedAt, source: "hydra" })
    .select("id")
    .single();
  if (!made.error) return (made.data as { id: string }).id;
  if (made.error.code !== "23505") throw fail("post", made.error);
  const hit = await db.from("posts").select("id, deal_id").eq("url", url).maybeSingle();
  if (hit.error) throw fail("post", hit.error);
  const row = hit.data as { id: string; deal_id: string } | null;
  return row && deal.dealIds.includes(row.deal_id) ? row.id : null;
}

async function syncBody(db: SupabaseClient, conn: SealedConnection, now: Date): Promise<SyncResult> {
  const token = liveToken(conn, now);
  const me = await profile(token, conn.ig_user_id);
  if (me.username !== conn.username) {
    const { error } = await ours(db, conn, { username: me.username });
    if (error) throw fail("account", error);
  }
  const day = dayKeyInZone(now, await zoneOf(db));
  if (me.followers !== null) {
    const { error } = await db.from("personal_brand_followers").upsert({ day, followers: me.followers, source: "instagram" }, { onConflict: "day" });
    if (error) throw fail("followers", error);
  }

  const deal = await brandDeal(db, me.username, day);
  const { media, cut } = await recentMedia(token, conn.ig_user_id, new Date(now.getTime() - WINDOW_DAYS * 86_400_000));
  if (cut) console.warn(`[instagram] media: the page cap stopped the read at ${media.length}; older media in the window were not synced`);
  const byCode = await postsByCode(db, deal.dealIds);
  let added = 0;
  let skipped = 0;
  const targets: { postId: string; m: Media }[] = [];
  for (const m of media) {
    const code = m.shortcode ?? (m.permalink ? shortcodeOf(m.permalink) : null);
    const url = m.permalink ? normalizePostUrl(m.permalink) : null;
    if (!code || !url) {
      skipped++;
      continue;
    }
    const known = byCode.get(code);
    let postId = known ? (known.pb ? known.id : null) : null;
    if (!known) {
      postId = await ensurePost(db, m, url, deal);
      if (postId) {
        added++;
        byCode.set(code, { id: postId, pb: true });
      }
    }
    if (postId) targets.push({ postId, m });
    else skipped++;
  }

  // One reading per post today. A throttle or a dead token stops the reads; what was read is still written. Any
  // other refusal is that post's. A sign-in that did not grant insights reads none.
  const rows = new Map<string, Record<string, unknown>>();
  const scopes = conn.scopes.split(/[\s,]+/).filter(Boolean);
  const insightsGranted = scopes.length === 0 || scopes.includes(INSTAGRAM_SCOPES[1]);
  let stop: unknown = null;
  let failures = 0;
  let refused = 0;
  for (let i = 0; insightsGranted && i < targets.length && !stop; i += PARALLEL) {
    const batch = targets.slice(i, i + PARALLEL);
    const read = await Promise.allSettled(batch.map((t) => mediaInsights(token, t.m.id)));
    read.forEach((r, j) => {
      const { postId, m } = batch[j];
      if (r.status === "rejected") {
        const e = r.reason;
        if (e instanceof InstagramError && (e.code === "rate_limited" || e.code === "reauth_required")) stop ??= e;
        else {
          console.error(`[instagram] insights ${m.id}: ${(e as Error).message}`);
          failures++;
          if (e instanceof InstagramError && e.permission) refused++;
        }
        return;
      }
      if (r.value.views === null) return;
      rows.set(postId, {
        post_id: postId,
        captured_day: day,
        captured_at: now.toISOString(),
        views: r.value.views,
        likes: r.value.likes ?? m.likes,
        comments: r.value.comments ?? m.comments,
        held: false,
        source: "hydra",
      });
    });
  }
  if (rows.size > 0) {
    const { error } = await db.from("post_view_snapshots").upsert([...rows.values()], { onConflict: "post_id,captured_day" });
    if (error) throw fail("views", error);
  }
  if (stop) throw stop;
  return {
    username: me.username,
    day,
    followers: me.followers,
    media: media.length,
    postsAdded: added,
    readings: rows.size,
    skipped: skipped + targets.length - rows.size - failures,
    insightsFailed: failures,
    insightsRefused: refused >= MIN_REFUSED_FOR_GRANT && refused === targets.length,
    cut,
    insightsGranted,
  };
}
