import "server-only";
import { InvalidEnvError, MissingEnvError } from "@/lib/bank/env";
import { TokenDecryptError } from "@/lib/bank/crypto";

/**
 * The Instagram API with Unified Login, as Meta documents it (research: IG-unified-research.md, read 2026-11-22):
 * the code exchange on graph.facebook.com with the Meta app, the Instagram professional account the sign-in
 * shared, its profile, media and media insights. The token is a business integration system user token: `/me`
 * is that system user, not the Instagram account, so every read names the account id.
 * Server only. A token rides in the query string, as Meta's docs show: never log a URL or a body from here.
 */

export type InstagramResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export type InstagramErrorCode = "reauth_required" | "rate_limited" | "instagram_error" | "not_connected" | "busy";

export class InstagramError extends Error {
  constructor(
    readonly code: InstagramErrorCode,
    message: string,
    /**
     * Graph 10 or 200-299: a permission refusal, not a dead token (190, 102, 401). It is an instagram_error, so one
     * media's refusal (Graph sends #10 for a media with too few viewers) is only that post's. On the account's own
     * reads (the shared account, its profile) `signedOut` makes it reauth_required.
     */
    readonly permission = false,
  ) {
    super(message);
    this.name = "InstagramError";
  }
}

/**
 * Read only: profile and media, plus media insights (Standard Access for the owner's own account). Not sent: the
 * Meta configuration (config_id) holds the permissions. The sync checks a stored grant list against the second.
 */
export const INSTAGRAM_SCOPES = ["instagram_basic", "instagram_manage_insights"] as const;

export const AUTHORIZE_URL = "https://www.facebook.com/dialog/oauth";
const GRAPH = "https://graph.facebook.com";
export const API = `${GRAPH}/v27.0`;

/**
 * META_APP_ID and META_APP_SECRET: the Meta app's ID and secret (App settings > Basic; not an Instagram app ID).
 * INSTAGRAM_CONFIG_ID: the Unified login configuration's config_id. Missing: fail closed.
 */
export function instagramEnv(env: Record<string, string | undefined> = process.env) {
  const get = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new MissingEnvError(name);
    return value;
  };
  return { appId: get("META_APP_ID"), appSecret: get("META_APP_SECRET"), configId: get("INSTAGRAM_CONFIG_ID") };
}

// Graph throttle codes: 4, 17, 341 (app and user limits), 32 and 613 (custom), 80002 (Instagram business use case).
const THROTTLE = new Set([4, 17, 32, 341, 613, 80002]);

/**
 * A Graph error body ({error: {code, type}}) as a typed error. 190 and 102 are an expired or revoked token (the app
 * removed from the business portfolio too): a new sign-in. 10 and 200-299 are a refused permission, marked
 * (`permission`): Graph also sends #10 for one media it will not report on (too few viewers), so it is not a
 * sign-in by itself (see `signedOut`).
 */
export function errorOf(status: number, body: unknown): InstagramError {
  const e = (body ?? {}) as { error?: { code?: unknown } };
  const code = Number(typeof e.error === "object" ? e.error?.code : undefined);
  if (status === 429 || THROTTLE.has(code)) return new InstagramError("rate_limited", "Instagram asked Hydra to slow down. Try again later.");
  if (code === 190 || code === 102 || status === 401) return new InstagramError("reauth_required", "Connect Instagram again");
  if (code === 10 || (code >= 200 && code <= 299)) return new InstagramError("instagram_error", `Instagram refused a permission (${status} ${code})`, true);
  return new InstagramError("instagram_error", `Instagram refused the request (${status}${Number.isFinite(code) ? ` ${code}` : ""})`);
}

/** A permission refusal on the account's own reads (the shared account, its profile) needs a new sign-in. */
function signedOut(e: unknown): never {
  throw e instanceof InstagramError && e.permission ? new InstagramError("reauth_required", "Connect Instagram again", true) : e;
}

async function call(url: string | URL): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new InstagramError("instagram_error", "Instagram did not answer");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.error) throw errorOf(res.status, body);
  return body;
}

const withQuery = (base: string, query: Record<string, string>) => {
  const url = new URL(base);
  url.search = new URLSearchParams(query).toString();
  return url;
};

const str = (v: unknown) => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const path = (id: string) => `${API}/${encodeURIComponent(id)}`;

export interface Token {
  accessToken: string;
  /** Null: the token never expires (the configuration's choice; Meta leaves expires_in out or sends 0). */
  expiresAt: Date | null;
}

/**
 * Trade the authorization code (once) for the token, on the server with the Meta app secret. GET with query
 * params, as Meta's docs show; redirect_uri is the login URL's own.
 */
export async function exchangeCode(input: { code: string; redirectUri: string }, now = Date.now()): Promise<Token> {
  const { appId, appSecret } = instagramEnv();
  const body = await call(withQuery(`${API}/oauth/access_token`, { client_id: appId, client_secret: appSecret, redirect_uri: input.redirectUri, code: input.code }));
  const accessToken = str(body.access_token);
  if (!accessToken) throw new InstagramError("instagram_error", "Instagram sent no token");
  const seconds = count(body.expires_in);
  return { accessToken, expiresAt: seconds ? new Date(now + seconds * 1000) : null };
}

export interface Account {
  userId: string;
  username: string;
}

/**
 * The Instagram professional account the sign-in shared (GET /me/assigned_instagram_accounts). Hydra keeps one:
 * the first, and the count is logged when there are more.
 */
export async function assignedAccount(token: string): Promise<Account> {
  const body = await call(withQuery(`${API}/me/assigned_instagram_accounts`, { fields: "id,username", access_token: token })).catch(signedOut);
  const rows = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
  if (rows.length > 1) console.warn(`[instagram] the sign-in shared ${rows.length} Instagram accounts; Hydra keeps the first`);
  const userId = str(rows[0]?.id);
  const username = str(rows[0]?.username);
  if (!userId || !username) throw new InstagramError("instagram_error", "The sign-in shared no Instagram account");
  return { userId, username };
}

export interface Profile {
  username: string;
  followers: number | null;
}

/** The account's username and follower count (GET /<ig id>). */
export async function profile(token: string, igUserId: string): Promise<Profile> {
  const d = await call(withQuery(path(igUserId), { fields: "id,username,followers_count", access_token: token })).catch(signedOut);
  const username = str(d.username);
  if (!username) throw new InstagramError("instagram_error", "Instagram did not say which account this is");
  return { username, followers: count(d.followers_count) };
}

export interface Media {
  id: string;
  shortcode: string | null;
  permalink: string | null;
  mediaType: string | null;
  postedAt: string;
  likes: number | null;
  comments: number | null;
}

/** No caption or media_product_type: Meta marks both "Instagram API with Facebook Login only". */
const MEDIA_FIELDS = "id,shortcode,permalink,media_type,timestamp,like_count,comments_count";
const MEDIA_PAGE = 50;

/**
 * The account's media made at or after `since` (sent as Meta's documented `since`, and checked here too), at most
 * `maxPages` pages. Paging stops at the page cap, or at a page with no media inside the window: one older item
 * (a pinned post) does not end it. `cut`: the cap stopped it with window media left unread (one more page is read
 * to tell; a plain refusal of it or no answer counts as cut, the likely case at the cap; a throttle or a dead token
 * is thrown). Follows paging.next on the API host only (it carries the token), else the after cursor.
 */
export async function recentMedia(token: string, igUserId: string, since: Date, maxPages = 10): Promise<{ media: Media[]; cut: boolean }> {
  const out: Media[] = [];
  const query = { fields: MEDIA_FIELDS, limit: String(MEDIA_PAGE), since: String(Math.floor(since.getTime() / 1000)), access_token: token };
  const inWindow = (body: Record<string, unknown>) =>
    (Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : []).flatMap((r) => {
      const id = str(r.id);
      const at = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
      if (!id || !Number.isFinite(at) || at < since.getTime()) return [];
      const m: Media = { id, shortcode: str(r.shortcode), permalink: str(r.permalink), mediaType: str(r.media_type), postedAt: new Date(at).toISOString(), likes: count(r.like_count), comments: count(r.comments_count) };
      return [m];
    });
  const list = `${path(igUserId)}/media`;
  let next: URL | null = withQuery(list, query);
  for (let page = 0; next && page < maxPages; page++) {
    const body = await call(next);
    const rows = inWindow(body);
    const inside = rows.length > 0;
    out.push(...rows);
    const paging = (body.paging ?? {}) as { next?: unknown; cursors?: { after?: unknown } };
    const after = str(paging.cursors?.after);
    next = !inside
      ? null
      : typeof paging.next === "string" && paging.next.startsWith(`${GRAPH}/`)
        ? new URL(paging.next)
        : after
          ? withQuery(list, { ...query, after })
          : null;
  }
  if (!next) return { media: out, cut: false };
  try {
    return { media: out, cut: inWindow(await call(next)).length > 0 };
  } catch (e) {
    if (e instanceof InstagramError && e.code === "instagram_error") return { media: out, cut: true };
    throw e;
  }
}

export interface Insights {
  views: number | null;
  likes: number | null;
  comments: number | null;
}

/**
 * Lifetime views, likes and comments of one media (views, likes and comments are valid for posts and reels).
 * A metric Instagram has no data for is left out of the answer: it comes back null here.
 */
export async function mediaInsights(token: string, mediaId: string): Promise<Insights> {
  const body = await call(withQuery(`${path(mediaId)}/insights`, { metric: "views,likes,comments", access_token: token }));
  const out: Insights = { views: null, likes: null, comments: null };
  for (const m of Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : []) {
    const values = m.values as { value?: unknown }[] | undefined;
    const total = m.total_value as { value?: unknown } | undefined;
    const value = count(values?.[0]?.value ?? total?.value);
    if (m.name === "views" || m.name === "likes" || m.name === "comments") out[m.name] = value;
  }
  return out;
}

/** Run an Instagram function and fold every failure into a result. Unknown errors are logged, not shown. */
export async function run<T>(body: () => Promise<T>): Promise<InstagramResult<T>> {
  try {
    return { ok: true, data: await body() };
  } catch (error) {
    if (error instanceof InstagramError) return { ok: false, error: { code: error.code, message: error.message } };
    if (error instanceof MissingEnvError || error instanceof InvalidEnvError) return { ok: false, error: { code: "not_configured", message: error.message } };
    if (error instanceof TokenDecryptError) return { ok: false, error: { code: "reauth_required", message: "Connect Instagram again" } };
    console.error(`[instagram] ${(error as Error).message}`);
    return { ok: false, error: { code: "internal", message: "Something went wrong" } };
  }
}
