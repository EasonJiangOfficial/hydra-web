import "server-only";
import { z } from "zod";
import { bearerKey, checkApiKey, UGC_WRITE } from "@/lib/keys/keys";
import { createAdminClient } from "@/lib/supabase/admin";
import { dayKeyInZone } from "@/lib/ugc/days";
import { addPostSchema, invalidInput, setViewsSchema, type ActionResult, type Platform } from "@/lib/ugc/schemas";
import * as w from "@/lib/ugc/writes";

/**
 * The Grokbot connector's four tools (DESIGN.md section 8), shared by the REST routes under
 * /api/ugc/v1 and the MCP server at /api/mcp/ugc. A `ugc:write` key reaches these four and
 * nothing else: no finance table is read, and there is no exclude, force or delete input.
 * Not a route: Next only serves route.ts.
 */

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** U1's addPost input, with the account required and the source fixed to "grokbot". */
export const addPostInput = addPostSchema.omit({ source: true }).extend({ account: addPostSchema.shape.account.unwrap() });
/** U1's setViews input without `force`: only the owner overrides the lower-count and jump guards. */
export const setViewsInput = setViewsSchema.omit({ force: true });
const noInput = z.object({});

// ─── Tools ───────────────────────────────────────────────────────────────────

const DEAL_COLUMNS =
  "id, brand_name, status, start_date, end_date, daily_target_posts, view_freeze_days, deal_accounts(id, platform, handle)";

interface DealRow {
  id: string;
  brand_name: string;
  status: string;
  start_date: string;
  end_date: string | null;
  daily_target_posts: number;
  view_freeze_days: number | null;
  deal_accounts: { id: string; platform: Platform; handle: string }[] | null;
}

/** Deals with their accounts, the server time and the owner's day, and any missed view days. */
async function ugcContext(db: w.Db) {
  const now = new Date();
  const zone = await w.zoneOf(db);
  const deals = await db.from("deals").select(DEAL_COLUMNS).order("start_date", { ascending: false });
  if (deals.error) return w.dbFail(deals.error);
  const missed = await db.rpc("ugc_missed_view_days", { p_days: 7, p_now: now.toISOString() });
  if (missed.error) return w.dbFail(missed.error);
  return w.ok({
    serverTime: now.toISOString(),
    timeZone: zone,
    today: dayKeyInZone(now, zone),
    deals: ((deals.data ?? []) as DealRow[]).map((d) => ({
      id: d.id,
      brandName: d.brand_name,
      status: d.status,
      startDate: d.start_date,
      endDate: d.end_date,
      dailyTargetPosts: d.daily_target_posts,
      viewFreezeDays: d.view_freeze_days,
      accounts: (d.deal_accounts ?? []).map((a) => ({ id: a.id, platform: a.platform, handle: a.handle })),
    })),
    missedDays: ((missed.data ?? []) as { day: string; posts_needing: number; posts_read: number }[]).map((m) => ({
      day: m.day,
      postsNeeding: m.posts_needing,
      postsRead: m.posts_read,
    })),
  });
}

/** Add a post (upsert on the normalized URL). Rates are snapshotted from the deal. */
async function ugcAddPost(db: w.Db, input: z.output<typeof addPostInput>) {
  const result = await w.addPost(db, { ...input, source: "grokbot" });
  if (!result.ok) return result;
  const { post, created } = result.data;
  return w.ok({
    postId: post.id,
    created,
    dealId: post.deal_id,
    url: post.url,
    platform: post.platform,
    postedAt: post.posted_at,
    videoGroupId: post.video_group_id,
  });
}

interface NeedingRow {
  post_id: string;
  deal_id: string;
  url: string;
  platform: Platform;
  account_handle: string | null;
  posted_at: string;
  freeze_ends_at: string;
  last_views: number | string | null;
  last_captured_at: string | null;
}

/** Today's work list: posts still counting views that have no reading today. */
async function ugcPostsNeedingViews(db: w.Db) {
  const now = new Date();
  const zone = await w.zoneOf(db);
  const { data, error } = await db.rpc("ugc_posts_needing_views", { p_now: now.toISOString() });
  if (error) return w.dbFail(error);
  return w.ok({
    today: dayKeyInZone(now, zone),
    posts: ((data ?? []) as NeedingRow[]).map((r) => ({
      postId: r.post_id,
      dealId: r.deal_id,
      url: r.url,
      platform: r.platform,
      account: r.account_handle,
      postedAt: r.posted_at,
      freezeEndsAt: r.freeze_ends_at,
      lastViews: r.last_views === null ? null : Number(r.last_views),
      lastCapturedAt: r.last_captured_at,
    })),
  });
}

/** One reading per post per owner-zone day. Lower counts are rejected, big jumps held for review. */
async function ugcSetViews(db: w.Db, input: z.output<typeof setViewsInput>) {
  return w.setViews(db, { ...input, force: false }, "grokbot");
}

// ─── Registry ────────────────────────────────────────────────────────────────

interface Tool<S extends z.ZodObject> {
  description: string;
  input: S;
  readOnly: boolean;
  run: (db: w.Db, input: z.output<S>) => Promise<ActionResult<unknown>>;
}
const tool = <S extends z.ZodObject>(t: Tool<S>) => t;

export const TOOLS = {
  ugc_context: tool({
    description: "Deals with their ids and accounts, the server time, the owner's day and zone, and missed view days. Call first; never invent ids.",
    input: noInput,
    readOnly: true,
    run: ugcContext,
  }),
  ugc_add_post: tool({
    description: "Add a posted video: {url, platform, account, dealId, postedAt, videoGroupId?}. The same URL twice is one post. Returns postId.",
    input: addPostInput,
    readOnly: false,
    run: ugcAddPost,
  }),
  ugc_posts_needing_views: tool({
    description: "Today's work list: posts that still count views and have no reading today, with the last reading.",
    input: noInput,
    readOnly: true,
    run: ugcPostsNeedingViews,
  }),
  ugc_set_views: tool({
    description: "Record view counts: {capturedAt, items: [{postId or url, views, likes?, comments?}]} (max 500). One reading per post per day; a lower count than the last is rejected and a jump over 10x is held for the owner's review.",
    input: setViewsInput,
    readOnly: false,
    run: ugcSetViews,
  }),
};
export type ToolName = keyof typeof TOOLS;

/** Validate and run one tool. Never throws. */
export async function runTool(name: ToolName, db: w.Db, input: unknown): Promise<ActionResult<unknown>> {
  const t = TOOLS[name] as Tool<z.ZodObject>;
  const parsed = t.input.safeParse(input ?? {});
  if (!parsed.success) return invalidInput(parsed.error);
  try {
    return await t.run(db, parsed.data);
  } catch (e) {
    return w.fail("db_error", e instanceof Error ? e.message : "Unexpected error");
  }
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

const STATUS: Record<string, number> = {
  invalid_input: 400,
  not_owner: 403,
  not_found: 404,
  conflict: 409,
  rejected: 422,
  db_error: 500,
};

const error = (status: number, code: string, message: string, headers?: Record<string, string>) =>
  Response.json({ ok: false, error: { code, message } }, { status, headers });

/**
 * The service-role client for a request carrying a valid `ugc:write` key, or the refusal:
 * 401 no, bad or revoked key; 403 a key without the scope; 429 over the key's per-minute limit.
 */
export async function authorize(request: Request): Promise<{ db: w.Db } | Response> {
  const unauthorized = () =>
    error(401, "unauthorized", "Send Authorization: Bearer <a Hydra ugc key>", { "www-authenticate": 'Bearer realm="hydra"' });
  const secret = bearerKey(request.headers.get("authorization"));
  if (!secret) return unauthorized();
  let db: w.Db;
  try {
    db = createAdminClient();
  } catch (e) {
    console.error(`[ugc connector] ${(e as Error).message}`);
    return error(503, "unavailable", "The connector is not configured");
  }
  const check = await checkApiKey(db, secret, UGC_WRITE);
  switch (check.status) {
    case "ok":
      return { db };
    case "rate_limited":
      return error(429, "rate_limited", "Too many requests for this key", { "retry-after": String(check.retryAfterSeconds) });
    case "forbidden":
      return error(403, "forbidden", "This key does not have the ugc:write scope");
    case "error":
      return error(503, "unavailable", "The key check failed");
    default:
      return unauthorized();
  }
}

export function respond(result: ActionResult<unknown>): Response {
  return Response.json(result, { status: result.ok ? 200 : (STATUS[result.error.code] ?? 500) });
}

const MAX_BODY_BYTES = 1_000_000;

/** The JSON body ({} when empty), or a 4xx Response. */
export async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return error(413, "invalid_input", "Body too large");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return error(413, "invalid_input", "Body too large");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return error(400, "invalid_input", "Body is not JSON");
  }
}

/** A REST handler for one tool: key check, then the body (POST) or no input (GET), then the tool. */
export function restTool(name: ToolName) {
  return async (request: Request): Promise<Response> => {
    const auth = await authorize(request);
    if (auth instanceof Response) return auth;
    let input: unknown = {};
    if (request.method === "POST") {
      input = await readBody(request);
      if (input instanceof Response) return input;
    }
    return respond(await runTool(name, auth.db, input));
  };
}
