// ponytail: no `import "server-only"` here. vitest cannot resolve that bare id
// (Next supplies it at build). Restore it with a vitest alias to
// next/dist/compiled/server-only/empty in vitest.config.mts.
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import {
  DEAL_DEFAULTS,
  dealInputToRow,
  dealRowToInput,
  dealSchema,
  invalidInput,
  normalizeHandle,
  type ActionErrorCode,
  type ActionResult,
  type DealDbRow,
  type Platform,
  type addPostSchema,
  type createDealSchema,
  type editPostSchema,
  type endDealSchema,
  type linkPostsSchema,
  type unlinkPostSchema,
  type decidePayoutRuleSchema,
  type matchPaymentSchema,
  type payoutPairSchema,
  type payoutRuleKeySchema,
  type setDayTargetSchema,
  type setViewsSchema,
  type updateDealSchema,
} from "@/lib/ugc/schemas";
import { matchCrossPosts, type MatchPost } from "@/lib/ugc/match";
import { decideViewSnapshot } from "@/lib/ugc/view-snapshots";
import { addDays, dayKeyInZone, ownerZone } from "@/lib/ugc/days";
import { nextPausedSpans, type PausedSpan } from "@/lib/ugc/ledger";

/**
 * The UGC write paths, on whatever client the caller holds. actions.ts calls
 * these as the signed-in owner (RLS applies); the Grokbot connector (U8) can
 * call addPost and setViews with its own client and source "grokbot". Inputs
 * here are already parsed by the schemas in schemas.ts. Never export these
 * from a "use server" file: a client parameter must not become an endpoint.
 */
export type Db = SupabaseClient;

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function fail(code: ActionErrorCode, message: string): ActionResult<never> {
  return { ok: false, error: { code, message } };
}

/** A Postgres / PostgREST error as a typed result. */
export function dbFail(error: PostgrestError): ActionResult<never> {
  switch (error.code) {
    case "23505":
      return fail("conflict", error.details || error.message);
    case "23503":
      return fail("not_found", "A row it points to does not exist");
    case "23514":
    case "22P02":
      return fail("invalid_input", error.message);
    case "42501":
      return fail("not_owner", error.message);
    case "PGRST116":
      return fail("not_found", "Not found");
    default:
      return fail("db_error", error.message);
  }
}

/** The owner's time zone from settings (UTC when unset). */
export async function zoneOf(db: Db): Promise<string> {
  const { data } = await db.from("settings").select("time_zone").limit(1).maybeSingle();
  return ownerZone((data as { time_zone: string | null } | null)?.time_zone);
}

/** Drop keys whose value is undefined (zod .partial() keeps them when sent). */
function defined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ─── Deals ───────────────────────────────────────────────────────────────────

/** A retry or double submit inside this window is the same create. */
const TWIN_WINDOW_MS = 10 * 60_000;

/** One string per value whatever its key order (jsonb comes back reordered). */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
}

/**
 * The oldest deal this create already made. With a source id the key is
 * (source, source_id). A hydra deal has no key (null source ids never collide
 * in the unique constraint), so it is the same brand, start date and pay
 * structure created inside the window. The logo path is not a term: a retry
 * copies or uploads the logo again to a fresh path.
 */
async function findTwin(
  db: Db,
  source: string,
  sourceId: string | null,
  row: ReturnType<typeof dealInputToRow>,
  now: Date,
): Promise<{ twin: DealDbRow | null; error: PostgrestError | null }> {
  let q = db.from("deals").select("*").eq("source", source);
  q =
    sourceId === null
      ? q
          .is("source_id", null)
          .eq("brand_name", row.brand_name)
          .eq("start_date", row.start_date)
          .gte("created_at", new Date(now.getTime() - TWIN_WINDOW_MS).toISOString())
      : q.eq("source_id", sourceId);
  const { data, error } = await q.order("created_at", { ascending: true }).order("id", { ascending: true }).limit(50);
  if (error) return { twin: null, error };
  const terms = (r: typeof row) => canon({ ...r, logo_path: null });
  const want = terms(row);
  const twin = ((data ?? []) as DealDbRow[]).find(
    (r) => sourceId !== null || terms(dealInputToRow(dealRowToInput(r))) === want,
  );
  return { twin: twin ?? null, error: null };
}

/**
 * Create a deal, safe to retry. The same source id, or (hydra) the same brand,
 * start date and pay terms made in the last 10 minutes, returns the deal that
 * already exists instead of a second one. A double click that races the check
 * is settled after the insert: the newer row removes itself.
 * ponytail: a hydra deal made again with identical terms inside 10 minutes
 * is read as a retry; a unique key in SQL would close the race for good.
 */
export async function createDeal(
  db: Db,
  input: z.output<typeof createDealSchema>,
  now: Date = new Date(),
): Promise<ActionResult<DealDbRow>> {
  const { source, sourceId, ...fields } = input;
  const full = dealSchema.safeParse({ ...DEAL_DEFAULTS, ...defined(fields) });
  if (!full.success) return invalidInput(full.error);
  const row = dealInputToRow(full.data);

  const before = await findTwin(db, source, sourceId, row, now);
  if (before.error) return dbFail(before.error);
  if (before.twin) return ok(before.twin);

  const { data, error } = await db
    .from("deals")
    .insert({ ...row, source, source_id: sourceId })
    .select("*")
    .single();
  if (error?.code === "23505" && sourceId !== null) {
    const raced = await findTwin(db, source, sourceId, row, now);
    return raced.twin ? ok(raced.twin) : dbFail(raced.error ?? error);
  }
  if (error) return dbFail(error);
  const created = data as DealDbRow;
  if (sourceId === null) {
    const after = await findTwin(db, source, sourceId, row, now);
    if (after.twin && after.twin.id !== created.id) {
      await db.from("deals").delete().eq("id", created.id);
      return ok(after.twin);
    }
  }
  return ok(created);
}

/**
 * Merge the patch over the stored deal and re-check the whole pay structure,
 * then write only the columns the patch changed, and only if the row still has
 * the version it was read at (updated_at). A concurrent write makes it re-read
 * and re-merge, so a stale value is never written back.
 */
export async function updateDeal(
  db: Db,
  input: z.output<typeof updateDealSchema>,
): Promise<ActionResult<DealDbRow>> {
  const { id, ...patch } = input;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await db.from("deals").select("*").eq("id", id).maybeSingle();
    if (current.error) return dbFail(current.error);
    if (!current.data) return fail("not_found", "No such deal");
    const stored = current.data as DealDbRow;
    const base = dealRowToInput(stored);
    const full = dealSchema.safeParse({ ...base, ...defined(patch) });
    if (!full.success) return invalidInput(full.error);
    const was = dealInputToRow(base);
    const changed = Object.fromEntries(
      Object.entries(dealInputToRow(full.data)).filter(([k, v]) => canon(v) !== canon(was[k as keyof typeof was])),
    );
    if (Object.keys(changed).length === 0) return ok(stored);
    const { data, error } = await db
      .from("deals")
      .update(changed)
      .eq("id", id)
      .eq("updated_at", stored.updated_at)
      .select("*")
      .maybeSingle();
    if (error) return dbFail(error);
    if (data) return ok(data as DealDbRow);
  }
  return fail("conflict", "The deal changed while you saved it. Try again.");
}

async function setStatus(
  db: Db,
  id: string,
  status: "active" | "paused" | "ended",
  from: readonly string[],
  extra: Record<string, unknown> = {},
): Promise<ActionResult<DealDbRow>> {
  const { data, error } = await db
    .from("deals")
    .update({ status, ...extra })
    .eq("id", id)
    .in("status", from as string[])
    .select("*")
    .maybeSingle();
  if (error) return dbFail(error);
  if (!data) {
    const exists = await db.from("deals").select("status").eq("id", id).maybeSingle();
    return exists.data
      ? fail("rejected", `The deal is ${(exists.data as { status: string }).status}`)
      : fail("not_found", "No such deal");
  }
  return ok(data as DealDbRow);
}

export const pauseDeal = (db: Db, id: string) => setStatus(db, id, "paused", ["active"]);

type StatusDeal = Pick<DealDbRow, "status" | "start_date" | "end_date"> & { paused_spans?: readonly PausedSpan[] | null };

/**
 * Archive with no date given: the deal stops making target days after today, and nothing else moves.
 *   - No end date: it ends today, or keeps none when it has not started (no day ever had a target).
 *   - An end date today or earlier: kept as it is.
 *   - An end date after today (a planned contract end): kept, and a pause covers tomorrow to that end,
 *     so Restore can give the plan back.
 * A pause still open closes on yesterday, as the deals_track_pause trigger does.
 */
export function archivePatch(deal: StatusDeal, today: string): { end_date: string | null; paused_spans: PausedSpan[] } {
  const spans = nextPausedSpans(deal.paused_spans, deal.status, "ended", today);
  const end = deal.end_date;
  if (end === null) return { end_date: deal.start_date > today ? null : today, paused_spans: spans };
  if (end <= today) return { end_date: end, paused_spans: spans };
  return { end_date: end, paused_spans: [...spans, { from: addDays(today, 1), to: end }] };
}

/**
 * Restore an archived deal: it runs again from today, and the archived days make no missed money.
 *   - The archive pause (it reaches today or later) is cut at yesterday.
 *   - An end date after today is the plan the archive kept: it stays.
 *   - An end date today or earlier: cleared (it runs with no end), and a pause covers the days from
 *     the day after that end to yesterday.
 */
export function restorePatch(deal: StatusDeal, today: string): { end_date: string | null; paused_spans: PausedSpan[] } {
  const yesterday = addDays(today, -1);
  const spans = (deal.paused_spans ?? []).flatMap((s) =>
    s.to !== null && s.to < today ? [s] : s.from > yesterday ? [] : [{ from: s.from, to: yesterday }],
  );
  const end = deal.end_date;
  if (end === null || end > today) return { end_date: end, paused_spans: spans };
  const gap = addDays(end, 1);
  return { end_date: null, paused_spans: gap <= yesterday ? [...spans, { from: gap, to: yesterday }] : spans };
}

async function readStatusDeal(db: Db, id: string): Promise<ActionResult<StatusDeal>> {
  const { data, error } = await db.from("deals").select("status, start_date, end_date, paused_spans").eq("id", id).maybeSingle();
  if (error) return dbFail(error);
  return data ? ok(data as StatusDeal) : fail("not_found", "No such deal");
}

/** Resume a pause, or restore an archived (ended) deal (restorePatch). */
export async function resumeDeal(db: Db, id: string, now: Date = new Date()): Promise<ActionResult<DealDbRow>> {
  const current = await readStatusDeal(db, id);
  if (!current.ok) return current;
  if (current.data.status !== "ended") return setStatus(db, id, "active", ["paused"]);
  const today = dayKeyInZone(now, await zoneOf(db));
  return setStatus(db, id, "active", ["ended"], restorePatch(current.data, today));
}

/** End a deal: status ended, on the end date given, or as Archive (archivePatch) when none is given. */
export async function endDeal(
  db: Db,
  input: z.output<typeof endDealSchema>,
  now: Date = new Date(),
): Promise<ActionResult<DealDbRow>> {
  const from = ["active", "paused", "ended"];
  if (input.endDate) return setStatus(db, input.id, "ended", from, { end_date: input.endDate });
  const current = await readStatusDeal(db, input.id);
  if (!current.ok) return current;
  return setStatus(db, input.id, "ended", from, archivePatch(current.data, dayKeyInZone(now, await zoneOf(db))));
}

export async function deleteDeal(db: Db, id: string): Promise<ActionResult<{ id: string }>> {
  const { data, error } = await db.from("deals").delete().eq("id", id).select("id").maybeSingle();
  if (error) return dbFail(error);
  return data ? ok({ id }) : fail("not_found", "No such deal");
}

// ─── Posts ───────────────────────────────────────────────────────────────────

const POST_COLUMNS =
  "id, deal_id, account_id, platform, url, title, posted_at, video_group_id, video_group_manual, exclude_from_pay, manual_override_cents, source, created_at, updated_at";

export interface PostDbRow {
  id: string;
  deal_id: string;
  account_id: string | null;
  platform: Platform;
  url: string;
  title: string | null;
  posted_at: string;
  video_group_id: string | null;
  /** True once the owner linked or unlinked this post by hand; the matcher leaves it alone. */
  video_group_manual?: boolean;
  exclude_from_pay: boolean;
  manual_override_cents: number | null;
  source: "hydra" | "grokbot" | "ripple";
  created_at: string;
  updated_at: string;
}

/** The deal's account for this platform and handle, created when new. */
async function ensureAccount(
  db: Db,
  dealId: string,
  platform: Platform,
  handle: string,
): Promise<ActionResult<string>> {
  const { data, error } = await db
    .from("deal_accounts")
    .upsert({ deal_id: dealId, platform, handle: normalizeHandle(handle) }, { onConflict: "deal_id,platform,handle" })
    .select("id")
    .single();
  return error ? dbFail(error) : ok((data as { id: string }).id);
}

/**
 * Add a post, or return the existing one for the same normalized URL (a retry
 * is safe). A re-add fills the account, group and title; it never moves the
 * post, never touches pay fields, never re-snapshots rates.
 */
export async function addPost(
  db: Db,
  input: z.output<typeof addPostSchema>,
): Promise<ActionResult<{ post: PostDbRow; created: boolean }>> {
  const existing = await db.from("posts").select(POST_COLUMNS).eq("url", input.url).maybeSingle();
  if (existing.error) return dbFail(existing.error);
  const prior = existing.data as PostDbRow | null;
  if (prior && prior.deal_id !== input.dealId) return fail("conflict", "This URL is on another deal");

  let accountId: string | null = prior?.account_id ?? null;
  if (input.account) {
    const account = await ensureAccount(db, input.dealId, input.platform, input.account);
    if (!account.ok) return account;
    accountId = account.data;
  }

  if (prior) {
    const { data, error } = await db
      .from("posts")
      .update({
        account_id: accountId,
        // A group the owner set by hand stays (the database refuses anyone else).
        video_group_id: prior.video_group_manual ? prior.video_group_id : (input.videoGroupId ?? prior.video_group_id),
        title: input.title ?? prior.title,
      })
      .eq("id", prior.id)
      .select(POST_COLUMNS)
      .single();
    return error ? dbFail(error) : ok({ post: data as PostDbRow, created: false });
  }

  const { data, error } = await db
    .from("posts")
    .insert({
      deal_id: input.dealId,
      account_id: accountId,
      platform: input.platform,
      url: input.url,
      posted_at: input.postedAt,
      video_group_id: input.videoGroupId ?? null,
      title: input.title ?? null,
      source: input.source,
    })
    .select(POST_COLUMNS)
    .single();
  return error ? dbFail(error) : ok({ post: await withCrossPosts(db, data as PostDbRow), created: true });
}

/** Edit a post. Moving it to another deal re-snapshots that deal's rates (database trigger). */
export async function editPost(
  db: Db,
  input: z.output<typeof editPostSchema>,
): Promise<ActionResult<PostDbRow>> {
  const current = await db.from("posts").select(POST_COLUMNS).eq("id", input.id).maybeSingle();
  if (current.error) return dbFail(current.error);
  const post = current.data as PostDbRow | null;
  if (!post) return fail("not_found", "No such post");

  const dealId = input.dealId ?? post.deal_id;
  const platform = input.platform ?? post.platform;
  const patch: Record<string, unknown> = defined({
    deal_id: input.dealId,
    url: input.url,
    platform: input.platform,
    posted_at: input.postedAt,
    video_group_id: input.videoGroupId,
    // A group set in an edit is the owner's hand link.
    video_group_manual: input.videoGroupId === undefined ? undefined : true,
    title: input.title,
    manual_override_cents: input.manualOverrideCents,
  });
  if (input.account === null) {
    patch.account_id = null;
  } else if (input.account !== undefined) {
    const account = await ensureAccount(db, dealId, platform, input.account);
    if (!account.ok) return account;
    patch.account_id = account.data;
  } else if (dealId !== post.deal_id) {
    patch.account_id = null; // the old account belongs to the old deal
  }

  const { data, error } = await db.from("posts").update(patch).eq("id", input.id).select(POST_COLUMNS).single();
  return error ? dbFail(error) : ok(data as PostDbRow);
}

/** Exclude or include a video. The database lets only the owner change it. */
export async function setExcluded(db: Db, id: string, excluded: boolean): Promise<ActionResult<PostDbRow>> {
  const { data, error } = await db
    .from("posts")
    .update({ exclude_from_pay: excluded })
    .eq("id", id)
    .select(POST_COLUMNS)
    .maybeSingle();
  if (error) return dbFail(error);
  return data ? ok(data as PostDbRow) : fail("not_found", "No such post");
}

export async function deletePost(db: Db, id: string): Promise<ActionResult<{ id: string }>> {
  const { data, error } = await db.from("posts").delete().eq("id", id).select("id").maybeSingle();
  if (error) return dbFail(error);
  return data ? ok({ id }) : fail("not_found", "No such post");
}

// ─── Cross-posts (one video on several platforms) ──────────────────────────

/** One post whose video changed: `from` and `to` are video_group_id values (null = on its own). */
export interface GroupChange {
  postId: string;
  from: string | null;
  to: string | null;
}

/** What a link, unlink or matcher run changed. */
export interface LinkActivity {
  dealId: string;
  changes: GroupChange[];
}

const MATCH_COLUMNS = "id, platform, title, posted_at, video_group_id, video_group_manual, exclude_from_pay, manual_override_cents";

/**
 * Run the cross-post matcher (match.ts) on one deal and write its links. Only
 * posts still where the matcher saw them (no group, or alone in an `auto-`
 * group) and not set by hand are written, so a race never overwrites a hand
 * link. With `onlyPostId`, only that post's video is written (a new post);
 * old posts move only through the reviewed backfill (scripts/ugc-link).
 * When a concurrent add moved a row first, it reads and matches again, so two
 * racing adds of one video end in one group.
 */
export async function linkCrossPosts(db: Db, dealId: string, onlyPostId?: string): Promise<ActionResult<LinkActivity>> {
  const changes: GroupChange[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows: MatchPost[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("posts").select(MATCH_COLUMNS).eq("deal_id", dealId).order("id").range(from, from + 999);
      if (error) return dbFail(error);
      const page = Array.isArray(data) ? (data as MatchPost[]) : [];
      rows.push(...page);
      if (page.length < 1000) break;
    }
    let links = matchCrossPosts(rows);
    if (onlyPostId) {
      const mine = rows.find((r) => r.id === onlyPostId);
      const target = links.find((l) => l.postId === onlyPostId)?.groupId ?? mine?.video_group_id;
      links = target ? links.filter((l) => l.groupId === target) : [];
    }
    const batches = new Map<string, { groupId: string; from: string | null; ids: string[] }>();
    for (const l of links) {
      const key = `${l.groupId}\u0000${l.from ?? ""}`;
      const b = batches.get(key) ?? { groupId: l.groupId, from: l.from ?? null, ids: [] };
      b.ids.push(l.postId);
      batches.set(key, b);
    }
    let short = false;
    for (const { groupId, from, ids } of batches.values()) {
      const q = db.from("posts").update({ video_group_id: groupId }).in("id", ids).eq("video_group_manual", false);
      const { data, error } = await (from ? q.eq("video_group_id", from) : q.is("video_group_id", null)).select("id");
      if (error) return dbFail(error);
      const done = (data ?? []) as { id: string }[];
      if (done.length < ids.length) short = true;
      for (const r of done) changes.push({ postId: r.id, from, to: groupId });
    }
    if (!short) break;
  }
  return ok({ dealId, changes });
}

/**
 * After a post is added: link that post's video and return the post with its
 * group. A re-add of an existing post does not run it (the backfill handles old
 * posts, after its dry run). ponytail: best effort; a failed match leaves the
 * post unlinked (paid on its own) and the backfill retries it.
 */
async function withCrossPosts(db: Db, post: PostDbRow): Promise<PostDbRow> {
  if (post.video_group_id || post.video_group_manual) return post;
  const r = await linkCrossPosts(db, post.deal_id, post.id);
  const mine = r.ok ? [...r.data.changes].reverse().find((c) => c.postId === post.id) : undefined;
  return mine ? { ...post, video_group_id: mine.to } : post;
}

/**
 * The owner links posts of one deal as one video. Every post already grouped
 * with them comes along (they are the same video). The group keeps the first
 * existing group id, else a new `manual-` id, and every member is marked
 * manual so the matcher never changes it.
 */
export async function linkPosts(db: Db, input: z.output<typeof linkPostsSchema>): Promise<ActionResult<LinkActivity>> {
  const ids = [...new Set(input.postIds)];
  const picked = await db.from("posts").select("id, deal_id, video_group_id").in("id", ids);
  if (picked.error) return dbFail(picked.error);
  const rows = (picked.data ?? []) as { id: string; deal_id: string; video_group_id: string | null }[];
  if (rows.length !== ids.length) return fail("not_found", "A post is gone");
  const dealId = rows[0].deal_id;
  if (rows.some((r) => r.deal_id !== dealId)) return fail("invalid_input", "Posts of one video must be on one deal");

  const groups = [...new Set(rows.flatMap((r) => (r.video_group_id ? [r.video_group_id] : [])))].sort();
  const all = new Map(rows.map((r) => [r.id, r.video_group_id]));
  if (groups.length > 0) {
    const mates = await db.from("posts").select("id, video_group_id").eq("deal_id", dealId).in("video_group_id", groups);
    if (mates.error) return dbFail(mates.error);
    for (const m of (mates.data ?? []) as { id: string; video_group_id: string | null }[]) all.set(m.id, m.video_group_id);
  }
  // A fresh id: `manual-<post id>` could still name a group left behind by an unlink.
  const groupId = groups[0] ?? `manual-${crypto.randomUUID()}`;
  const { error } = await db
    .from("posts")
    .update({ video_group_id: groupId, video_group_manual: true })
    .in("id", [...all.keys()]);
  if (error) return dbFail(error);
  const changes = [...all.entries()]
    .filter(([, from]) => from !== groupId)
    .map(([postId, from]) => ({ postId, from, to: groupId }))
    .sort((a, b) => (a.postId < b.postId ? -1 : 1));
  return ok({ dealId, changes });
}

/** The owner takes a post out of its video: it pays on its own and the matcher never links it again. */
export async function unlinkPost(db: Db, input: z.output<typeof unlinkPostSchema>): Promise<ActionResult<LinkActivity>> {
  const { data, error } = await db
    .from("posts")
    .select("id, deal_id, video_group_id")
    .eq("id", input.postId)
    .maybeSingle();
  if (error) return dbFail(error);
  const post = data as { id: string; deal_id: string; video_group_id: string | null } | null;
  if (!post) return fail("not_found", "No such post");
  const up = await db.from("posts").update({ video_group_id: null, video_group_manual: true }).eq("id", post.id);
  if (up.error) return dbFail(up.error);
  return ok({
    dealId: post.deal_id,
    changes: post.video_group_id ? [{ postId: post.id, from: post.video_group_id, to: null }] : [],
  });
}

// ─── Views ───────────────────────────────────────────────────────────────────

export type SetViewsItemStatus = "written" | "held" | "rejected_lower" | "rejected_frozen" | "not_found";

export interface SetViewsItemResult {
  postId: string | null;
  url: string | null;
  status: SetViewsItemStatus;
  /** The last trusted reading, for rejected_lower and held. */
  previous?: number;
  /** held only: the day already had a trusted reading, so it was kept and this value was not stored. */
  notStored?: true;
}

/**
 * Store one reading per post for the owner-zone day of `capturedAt`. The
 * guard baseline includes the day's own trusted reading, even one captured
 * later than `capturedAt` (a late delivery). Per item: a lower count is
 * rejected unless forced, a jump over the set multiple is held for review (and
 * never replaces the day's trusted reading: it comes back notStored), a
 * reading after the freeze window is rejected. Items report their own outcome.
 * ponytail: the read-then-upsert is not atomic; two writers on one post and
 * day in the same instant can still last-write-win until SQL guards the upsert.
 */
export async function setViews(
  db: Db,
  input: z.output<typeof setViewsSchema>,
  source: "hydra" | "grokbot" = "hydra",
): Promise<ActionResult<{ day: string; items: SetViewsItemResult[] }>> {
  const capturedAt = new Date(input.capturedAt);
  const day = dayKeyInZone(capturedAt, await zoneOf(db));
  const ids = input.items.flatMap((i) => (i.postId ? [i.postId] : []));
  const urls = input.items.flatMap((i) => (i.url ? [i.url] : []));

  type Target = { id: string; url: string; posted_at: string; deals: { view_freeze_days: number | null } | null };
  const found: Target[] = [];
  for (const [column, values] of [["id", ids], ["url", urls]] as const) {
    if (values.length === 0) continue;
    const { data, error } = await db
      .from("posts")
      .select("id, url, posted_at, deals(view_freeze_days)")
      .in(column, values);
    if (error) return dbFail(error);
    found.push(...((data ?? []) as unknown as Target[]));
  }
  const byId = new Map(found.map((p) => [p.id, p]));
  const byUrl = new Map(found.map((p) => [p.url, p]));

  const baseline = await db.rpc("ugc_last_trusted_views", {
    p_post_ids: found.map((p) => p.id),
    p_at: capturedAt.toISOString(),
  });
  if (baseline.error) return dbFail(baseline.error);
  const previous = new Map(
    ((baseline.data ?? []) as { post_id: string; views: number }[]).map((r) => [r.post_id, Number(r.views)]),
  );

  // The day's stored reading per post (one row per post and day), kept current as items stage.
  type DayRow = { views: number; held: boolean; at: number };
  const dayRows = new Map<string, DayRow>();
  if (byId.size > 0) {
    const stored = await db
      .from("post_view_snapshots")
      .select("post_id, views, held, captured_at")
      .eq("captured_day", day)
      .in("post_id", [...byId.keys()]);
    if (stored.error) return dbFail(stored.error);
    for (const r of (stored.data ?? []) as { post_id: string; views: number; held: boolean; captured_at: string }[]) {
      dayRows.set(r.post_id, { views: Number(r.views), held: r.held, at: Date.parse(r.captured_at) });
    }
  }

  const results: SetViewsItemResult[] = [];
  const rows = new Map<string, Record<string, unknown>>(); // one row per post: the last item wins
  for (const item of input.items) {
    const post = item.postId ? byId.get(item.postId) : byUrl.get(item.url!);
    if (!post) {
      results.push({ postId: item.postId ?? null, url: item.url ?? null, status: "not_found" });
      continue;
    }
    const today = dayRows.get(post.id);
    const prev = today && !today.held && today.at >= capturedAt.getTime() ? today.views : previous.get(post.id);
    const decision = decideViewSnapshot({
      previous: prev === undefined ? null : { views: prev },
      views: item.views,
      capturedAt,
      postedAt: new Date(post.posted_at),
      freezeDays: post.deals?.view_freeze_days ?? null,
      force: input.force,
    });
    const base = { postId: post.id, url: post.url };
    if (decision.kind === "reject_lower") {
      results.push({ ...base, status: "rejected_lower", previous: decision.previous });
      continue;
    }
    if (decision.kind === "reject_frozen") {
      results.push({ ...base, status: "rejected_frozen" });
      continue;
    }
    if (decision.kind === "hold" && today && !today.held) {
      results.push({ ...base, status: "held", previous: decision.previous, notStored: true });
      continue;
    }
    dayRows.set(post.id, { views: item.views, held: decision.held, at: capturedAt.getTime() });
    rows.set(post.id, {
      post_id: post.id,
      captured_day: day,
      captured_at: capturedAt.toISOString(),
      views: item.views,
      likes: item.likes ?? null,
      comments: item.comments ?? null,
      held: decision.held,
      source,
    });
    results.push(
      decision.kind === "hold"
        ? { ...base, status: "held", previous: decision.previous }
        : { ...base, status: "written" },
    );
  }

  if (rows.size > 0) {
    const { error } = await db
      .from("post_view_snapshots")
      .upsert([...rows.values()], { onConflict: "post_id,captured_day" });
    if (error) return dbFail(error);
  }
  return ok({ day, items: results });
}

// ─── Day targets and payments ────────────────────────────────────────────────

export async function setDayTarget(
  db: Db,
  input: z.output<typeof setDayTargetSchema>,
): Promise<ActionResult<{ dealId: string; day: string; target: number | null }>> {
  const { dealId, day, target } = input;
  const { error } =
    target === null
      ? await db.from("day_targets").delete().eq("deal_id", dealId).eq("day", day)
      : await db.from("day_targets").upsert({ deal_id: dealId, day, target }, { onConflict: "deal_id,day" });
  return error ? dbFail(error) : ok({ dealId, day, target });
}

export interface DealPaymentRow {
  id: string;
  deal_id: string;
  transaction_id: string;
  amount_cents: number;
  paid_on: string;
  created_at: string;
}

export async function matchPayment(
  db: Db,
  input: z.output<typeof matchPaymentSchema>,
): Promise<ActionResult<DealPaymentRow>> {
  const { data, error } = await db
    .from("deal_payments")
    .insert({
      deal_id: input.dealId,
      transaction_id: input.transactionId,
      amount_cents: input.amountCents,
      paid_on: input.paidOn,
    })
    .select("*")
    .single();
  if (error?.code === "23505") return fail("conflict", "This deposit is already matched to a deal");
  // 0030 deal_payments_refuse_transfer: a deposit paired as a transfer is not a deal payment.
  if (error?.code === "23514") return fail("rejected", error.message);
  return error ? dbFail(error) : ok(data as DealPaymentRow);
}

/** Confirm a suggested payout: the deposit's own amount and day, through matchPayment. */
export async function confirmPayoutMatch(
  db: Db,
  input: z.output<typeof payoutPairSchema>,
): Promise<ActionResult<DealPaymentRow>> {
  const { data, error } = await db
    .from("transactions")
    .select("id, amount_cents, posted_on, hidden")
    .eq("id", input.transactionId)
    .maybeSingle();
  if (error) return dbFail(error);
  if (!data) return fail("not_found", "No such deposit");
  if (data.hidden) return fail("rejected", "That transaction is hidden");
  const amountCents = Number(data.amount_cents);
  if (!(amountCents > 0)) return fail("rejected", "Only a deposit can pay a deal");
  return matchPayment(db, { dealId: input.dealId, transactionId: input.transactionId, amountCents, paidOn: data.posted_on });
}

/** "Not this": the deposit is never suggested for this deal again. */
export async function rejectPayoutMatch(
  db: Db,
  input: z.output<typeof payoutPairSchema>,
): Promise<ActionResult<{ dealId: string; transactionId: string }>> {
  const { error } = await db
    .from("payout_match_rejections")
    .upsert({ deal_id: input.dealId, transaction_id: input.transactionId }, { onConflict: "deal_id,transaction_id", ignoreDuplicates: true });
  return error ? dbFail(error) : ok({ dealId: input.dealId, transactionId: input.transactionId });
}

/** Undo "Not this": the deposit can be suggested for this deal again. */
export async function undoRejectPayoutMatch(
  db: Db,
  input: z.output<typeof payoutPairSchema>,
): Promise<ActionResult<{ dealId: string; transactionId: string }>> {
  const { error } = await db
    .from("payout_match_rejections")
    .delete()
    .eq("deal_id", input.dealId)
    .eq("transaction_id", input.transactionId);
  return error ? dbFail(error) : ok({ dealId: input.dealId, transactionId: input.transactionId });
}

/** Forget a rule answer (kept or turned down): the rule stops applying and can be offered again. */
export async function removePayoutRule(
  db: Db,
  input: z.output<typeof payoutRuleKeySchema>,
): Promise<ActionResult<{ dealId: string; payerKey: string }>> {
  const { error } = await db.from("payout_rules").delete().eq("deal_id", input.dealId).eq("payer_key", input.payerKey);
  return error ? dbFail(error) : ok({ dealId: input.dealId, payerKey: input.payerKey });
}

export interface PayoutRuleRow {
  id: string;
  deal_id: string;
  payer_key: string;
  day_of_month: number | null;
  day_window: number;
  decision: "accepted" | "declined";
}

/** Keep or turn down a learned payout rule. One rule per deal and payer; a new answer replaces the old. */
export async function decidePayoutRule(
  db: Db,
  input: z.output<typeof decidePayoutRuleSchema>,
): Promise<ActionResult<PayoutRuleRow>> {
  const { data, error } = await db
    .from("payout_rules")
    .upsert(
      { deal_id: input.dealId, payer_key: input.payerKey, day_of_month: input.dayOfMonth, decision: input.decision },
      { onConflict: "deal_id,payer_key" },
    )
    .select("id, deal_id, payer_key, day_of_month, day_window, decision")
    .single();
  return error ? dbFail(error) : ok(data as PayoutRuleRow);
}

export async function unmatchPayment(db: Db, transactionId: string): Promise<ActionResult<{ transactionId: string }>> {
  const { data, error } = await db
    .from("deal_payments")
    .delete()
    .eq("transaction_id", transactionId)
    .select("id")
    .maybeSingle();
  if (error) return dbFail(error);
  return data ? ok({ transactionId }) : fail("not_found", "This deposit is not matched");
}
