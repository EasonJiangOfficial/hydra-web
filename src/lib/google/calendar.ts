import "server-only";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, dayOf, zonedInstant } from "@/lib/planning/dates";
import type { RepeatRule } from "@/lib/planning/repeat";
import { loadTimeZone } from "@/lib/planning/repository";
import type { EventRow, PlanningTaskRow } from "@/lib/planning/rows";
import { createAdminClient } from "@/lib/supabase/admin";
import { GoogleApiError, googleApi, GoogleError, loadAccount, requireApproval, run, type GoogleResult } from "./client";

/**
 * Two-way sync between Planning and the dedicated "Hydra" Google calendar (DESIGN.md 6.2 and 10).
 *
 * - Push on write: a Planning action calls pushToGoogle(kind, id) after it saves, and
 *   removeFromGoogle(kind, id) after a delete the owner already confirmed. A dated task is an
 *   all-day event on its due date; an undated task is not on the calendar.
 * - Pull: pullCalendar() lists what changed since the stored sync token (the watch channel's
 *   webhook and the cron call it). A 410 from Google means the token expired: one full sync.
 * - Conflict rule: last edit wins, by Hydra's updated_at against Google's `updated`. A pull that
 *   sees the etag Hydra last wrote skips it (its own write coming back).
 * - Deletes ask: an event deleted in Google never deletes a Hydra item by itself. The link is
 *   marked pending; confirmPendingDelete (with the confirm gate's approval id) or keepPendingDelete
 *   settles it.
 */

const API = "https://www.googleapis.com/calendar/v3";
const WATCH_TTL_S = 7 * 24 * 3600;
const RENEW_BEFORE_MS = 24 * 3600 * 1000;

export type ItemKind = "task" | "event";
export type PushOutcome = "created" | "updated" | "removed" | "skipped" | "not_connected" | "not_found" | "waiting_for_owner";

export interface GoogleEvent {
  id: string;
  status?: string;
  etag?: string;
  updated?: string;
  summary?: string;
  description?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  recurrence?: string[];
  transparency?: string;
  extendedProperties?: { private?: Record<string, string> };
}

type EventBody = Omit<GoogleEvent, "id">;

interface LinkRow {
  id: string;
  item_kind: ItemKind;
  item_id: string;
  google_event_id: string;
  google_etag: string | null;
  pending: string | null;
}

interface Ctx {
  db: SupabaseClient;
  accountId: string;
  calendarId: string;
  timeZone: string;
}

// ---------------------------------------------------------------------------
// Mapping (pure)
// ---------------------------------------------------------------------------

const RRULES: Record<RepeatRule, string> = {
  daily: "RRULE:FREQ=DAILY",
  weekdays: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
  weekly: "RRULE:FREQ=WEEKLY",
  monthly: "RRULE:FREQ=MONTHLY",
};

// ponytail: only Hydra's four rules map back; any other Google recurrence pulls in as a one-off
// (its first occurrence). Map more RRULEs if the owner builds repeats in Google.
const repeatOf = (recurrence: string[] | undefined): RepeatRule | null =>
  (Object.keys(RRULES) as RepeatRule[]).find((r) => recurrence?.length === 1 && recurrence[0] === RRULES[r]) ?? null;

const tag = (kind: ItemKind, id: string) => ({ private: { hydraKind: kind, hydraId: id } });

/** A dated task as an all-day event on its due date. Null: an undated task is not on the calendar. */
export function taskToGoogle(t: PlanningTaskRow): EventBody | null {
  if (!t.due_date) return null;
  return {
    summary: t.title,
    description: t.notes,
    start: { date: t.due_date },
    end: { date: addDays(t.due_date, 1) },
    recurrence: [], // each repeat copy is its own task, so its own event
    transparency: "transparent",
    extendedProperties: tag("task", t.id),
  };
}

export function eventToGoogle(e: EventRow, timeZone: string): EventBody {
  const when = e.all_day
    ? { start: { date: dayOf(e.starts_at, timeZone) }, end: { date: addDays(dayOf(e.ends_at ?? e.starts_at, timeZone), 1) } }
    : { start: { dateTime: e.starts_at, timeZone }, end: { dateTime: e.ends_at ?? e.starts_at, timeZone } };
  return {
    summary: e.title,
    description: e.notes,
    ...when,
    recurrence: e.repeat ? [RRULES[e.repeat as RepeatRule]] : [],
    extendedProperties: tag("event", e.id),
  };
}

/** A Google event as Hydra event columns (all-day days are midnights in the owner's zone). */
export function eventFromGoogle(g: GoogleEvent, timeZone: string) {
  const base = {
    title: (g.summary?.trim() || "(No title)").slice(0, 200),
    notes: (g.description ?? "").slice(0, 20000),
    repeat: repeatOf(g.recurrence),
  };
  if (g.start?.date) {
    const last = g.end?.date ? addDays(g.end.date, -1) : g.start.date;
    return {
      ...base,
      all_day: true,
      starts_at: zonedInstant(g.start.date, "00:00", timeZone).toISOString(),
      ends_at: last > g.start.date ? zonedInstant(last, "00:00", timeZone).toISOString() : null,
    };
  }
  const start = new Date(g.start?.dateTime ?? Number.NaN).toISOString();
  const end = g.end?.dateTime ? new Date(g.end.dateTime).toISOString() : null;
  return { ...base, all_day: false, starts_at: start, ends_at: end && end > start ? end : null };
}

/** A Google event's changes as task columns: title, notes, due date. */
export function taskFromGoogle(g: GoogleEvent, timeZone: string) {
  const e = eventFromGoogle(g, timeZone);
  return { title: e.title, notes: e.notes, due_date: g.start?.date ?? dayOf(e.starts_at, timeZone) };
}

// ---------------------------------------------------------------------------
// Store helpers (service role)
// ---------------------------------------------------------------------------

/** The query's data (unknown: the client is untyped until typegen lands), or throw its error. */
function must(what: string, result: { data: unknown; error: { message: string } | null }): unknown {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

const TABLE: Record<ItemKind, string> = { task: "planning_tasks", event: "events" };
const LINK_COLUMNS = "id, item_kind, item_id, google_event_id, google_etag, pending";
const isGone = (e: unknown) => e instanceof GoogleApiError && (e.status === 404 || e.status === 410);

async function loadItem(db: SupabaseClient, kind: ItemKind, id: string): Promise<(PlanningTaskRow & EventRow) | null> {
  return must(kind, await db.from(TABLE[kind]).select("*").eq("id", id).maybeSingle()) as (PlanningTaskRow & EventRow) | null;
}

async function linkFor(db: SupabaseClient, kind: ItemKind, id: string): Promise<LinkRow | null> {
  return must("calendar link", await db.from("google_calendar_links").select(LINK_COLUMNS).eq("item_kind", kind).eq("item_id", id).maybeSingle()) as LinkRow | null;
}

async function saveLink(ctx: Ctx, kind: ItemKind, itemId: string, g: GoogleEvent): Promise<LinkRow> {
  const row = {
    account_id: ctx.accountId,
    item_kind: kind,
    item_id: itemId,
    google_event_id: g.id,
    google_etag: g.etag ?? null,
    google_updated_at: g.updated ?? null,
    pending: null,
  };
  const saved = must(
    "calendar link",
    await ctx.db.from("google_calendar_links").upsert(row, { onConflict: "item_kind,item_id" }).select(LINK_COLUMNS).single(),
  );
  return saved as LinkRow;
}

async function context(db: SupabaseClient): Promise<Ctx | null> {
  const account = await loadAccount(db);
  if (!account) return null;
  const timeZone = await loadTimeZone(db);
  const sync = must("calendar sync", await db.from("google_calendar_sync").select("calendar_id").eq("account_id", account.id).maybeSingle()) as {
    calendar_id: string | null;
  } | null;
  let calendarId = sync?.calendar_id;
  if (!calendarId) {
    // ponytail: two first writes at once can each create a "Hydra" calendar; the later upsert wins
    // and the other stays empty. Single owner, once per sign-in: add a lock if it ever shows up.
    const created = await googleApi<{ id: string }>(`${API}/calendars`, { method: "POST", body: { summary: "Hydra", timeZone } }, db);
    calendarId = created.id;
    must("calendar sync", await db.from("google_calendar_sync").upsert({ account_id: account.id, calendar_id: calendarId }, { onConflict: "account_id" }));
  }
  return { db, accountId: account.id, calendarId, timeZone };
}

const eventsUrl = (ctx: Ctx) => `${API}/calendars/${encodeURIComponent(ctx.calendarId)}/events`;

// ---------------------------------------------------------------------------
// Push (Hydra -> Google)
// ---------------------------------------------------------------------------

/**
 * The Google id of an item's event: fixed per item and generation (base32hex, as Google requires), so
 * two pushes racing to create it make one event (the loser gets 409 and patches it instead).
 * Generation 0 is the first event; each later one follows a copy Google keeps as deleted.
 */
export const googleIdFor = (kind: ItemKind, id: string, generation = 0) =>
  `${kind === "task" ? "t" : "e"}${id.replace(/-/g, "").toLowerCase()}${generation ? `g${generation.toString(32)}` : ""}`;
const MAX_GENERATIONS = 50;

async function patchEvent(ctx: Ctx, googleId: string, body: EventBody): Promise<GoogleEvent> {
  try {
    return await googleApi<GoogleEvent>(`${eventsUrl(ctx)}/${encodeURIComponent(googleId)}`, { method: "PATCH", body }, ctx.db);
  } catch (error) {
    if (!isGone(error)) throw error;
    return { id: googleId, status: "cancelled" };
  }
}

/** `fresh`: make a new Google event with a Google-chosen id (putting back one deleted in Google). */
async function push(ctx: Ctx, kind: ItemKind, id: string, link: LinkRow | null, fresh = false): Promise<PushOutcome> {
  const row = await loadItem(ctx.db, kind, id);
  if (!row) return "not_found";
  const body = kind === "task" ? taskToGoogle(row) : eventToGoogle(row, ctx.timeZone);
  if (!body) {
    if (!link) return "skipped";
    await dropRemote(ctx, link);
    return "removed";
  }
  let saved: GoogleEvent;
  if (link) saved = await patchEvent(ctx, link.google_event_id, body);
  else if (fresh) saved = await googleApi<GoogleEvent>(eventsUrl(ctx), { method: "POST", body }, ctx.db);
  else {
    // The fixed id, then (when Google holds it as deleted, and no link says it is live: Hydra removed
    // it when the task lost its date, or the owner kept an undated task) the next fixed id after it.
    // Every push walks the same ids, so two racing pushes meet on one event instead of making two.
    // ponytail: walks past each earlier deleted copy; a generation on the item if that ever gets long.
    for (let generation = 0; ; generation++) {
      if (generation >= MAX_GENERATIONS) throw new GoogleError("google_error", "Too many deleted copies of this item in Google");
      const googleId = googleIdFor(kind, id, generation);
      try {
        saved = await googleApi<GoogleEvent>(eventsUrl(ctx), { method: "POST", body: { ...body, id: googleId } }, ctx.db);
      } catch (error) {
        if (!(error instanceof GoogleApiError && error.status === 409)) throw error;
        saved = await patchEvent(ctx, googleId, body);
      }
      if (saved.status !== "cancelled") break;
    }
  }
  if (saved.status === "cancelled") {
    // Deleted in Google while edited in Hydra: a delete never wins by itself. Ask.
    const pending = link ?? (await saveLink(ctx, kind, id, saved));
    must("calendar link", await ctx.db.from("google_calendar_links").update({ pending: "delete_in_hydra" }).eq("id", pending.id));
    return "waiting_for_owner";
  }
  await saveLink(ctx, kind, id, saved);
  if (kind === "event" && row.google_event_id !== saved.id) {
    must("event", await ctx.db.from("events").update({ google_event_id: saved.id }).eq("id", id));
  }
  return link ? "updated" : "created";
}

async function dropRemote(ctx: Ctx, link: LinkRow) {
  try {
    await googleApi(`${eventsUrl(ctx)}/${encodeURIComponent(link.google_event_id)}`, { method: "DELETE" }, ctx.db);
  } catch (error) {
    if (!isGone(error)) throw error;
  }
  must("calendar link", await ctx.db.from("google_calendar_links").delete().eq("id", link.id));
}

/**
 * Mirror a Planning task or event to the Hydra calendar after it was written. Safe to call for
 * every write: no Google sign-in is "not_connected", an undated task is "skipped" (or "removed").
 */
export async function pushToGoogle(kind: ItemKind, id: string): Promise<GoogleResult<PushOutcome>> {
  return run(async () => {
    const db = createAdminClient();
    const ctx = await context(db);
    if (!ctx) return "not_connected";
    const link = await linkFor(db, kind, id);
    if (link?.pending) return "waiting_for_owner";
    return push(ctx, kind, id, link);
  });
}

/**
 * Remove the Google copy of a Planning item the owner deleted. The Planning delete is the one the
 * confirm gate asked about; this only follows it.
 */
export async function removeFromGoogle(kind: ItemKind, id: string): Promise<GoogleResult<PushOutcome>> {
  return run(async () => {
    const db = createAdminClient();
    const link = await linkFor(db, kind, id);
    if (!link) return "skipped";
    const ctx = await context(db);
    if (!ctx) return "not_connected";
    await dropRemote(ctx, link);
    return "removed";
  });
}

/**
 * After a sign-in: put the Planning items that are not on the calendar yet on it. Every event, and
 * the tasks due from 30 days ago on.
 */
export async function pushAll(): Promise<GoogleResult<{ pushed: number }>> {
  return run(async () => {
    const db = createAdminClient();
    const ctx = await context(db);
    if (!ctx) return { pushed: 0 };
    const cutoff = addDays(dayOf(new Date().toISOString(), ctx.timeZone), -30);
    const [events, tasks, links] = await Promise.all([
      db.from("events").select("id"),
      db.from("planning_tasks").select("id").gte("due_date", cutoff),
      db.from("google_calendar_links").select("item_kind, item_id"),
    ]);
    const linked = new Set(((must("calendar links", links) ?? []) as { item_kind: string; item_id: string }[]).map((l) => `${l.item_kind}:${l.item_id}`));
    const items: [ItemKind, string][] = [
      ...((must("events", events) ?? []) as { id: string }[]).map((r) => ["event", r.id] as [ItemKind, string]),
      ...((must("tasks", tasks) ?? []) as { id: string }[]).map((r) => ["task", r.id] as [ItemKind, string]),
    ];
    let pushed = 0;
    for (const [kind, id] of items) {
      if (linked.has(`${kind}:${id}`)) continue;
      if ((await push(ctx, kind, id, null)) === "created") pushed++;
    }
    return { pushed };
  });
}

// ---------------------------------------------------------------------------
// Pull (Google -> Hydra)
// ---------------------------------------------------------------------------

export interface PullSummary {
  connected: boolean;
  fullSync: boolean;
  created: number;
  updated: number;
  pushed: number;
  pendingDeletes: number;
  skipped: number;
}

type Applied = "created" | "updated" | "pushed" | "pendingDeletes" | "skipped";

async function listChanges(ctx: Ctx, syncToken: string | null): Promise<{ items: GoogleEvent[]; nextSyncToken: string }> {
  const items: GoogleEvent[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const page = await googleApi<{ items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string }>(
      eventsUrl(ctx),
      { query: { syncToken: syncToken ?? undefined, pageToken, maxResults: 250 } },
      ctx.db,
    );
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
    if (!pageToken) {
      if (!page.nextSyncToken) throw new Error("calendar list: no sync token");
      return { items, nextSyncToken: page.nextSyncToken };
    }
  }
}

async function applyRemote(ctx: Ctx, g: GoogleEvent): Promise<Applied> {
  let link = must(
    "calendar link",
    await ctx.db.from("google_calendar_links").select(LINK_COLUMNS).eq("account_id", ctx.accountId).eq("google_event_id", g.id).maybeSingle(),
  ) as LinkRow | null;
  const hydra = g.extendedProperties?.private;
  if (!link && hydra?.hydraId && (hydra.hydraKind === "task" || hydra.hydraKind === "event")) {
    // Hydra made this event but lost the link (a crash between the create and the link save).
    // A tagged event whose item is gone stays out: the owner deleted it in Hydra.
    if (!(await loadItem(ctx.db, hydra.hydraKind, hydra.hydraId))) return "skipped";
    link = await saveLink(ctx, hydra.hydraKind, hydra.hydraId, { id: g.id });
  }

  if (g.status === "cancelled") {
    if (!link || link.pending) return "skipped";
    must("calendar link", await ctx.db.from("google_calendar_links").update({ pending: "delete_in_hydra" }).eq("id", link.id));
    return "pendingDeletes";
  }

  if (!link) {
    // Made in Google on the Hydra calendar: a new Planning event.
    const { data, error } = await ctx.db
      .from("events")
      .insert({ ...eventFromGoogle(g, ctx.timeZone), google_event_id: g.id })
      .select("id")
      .single();
    if (error?.code === "23505") return "skipped"; // another pull imported it first
    if (error || !data) throw new Error(`event: ${error?.message ?? "not saved"}`);
    await saveLink(ctx, "event", (data as { id: string }).id, g);
    return "created";
  }

  if (link.pending) return "skipped"; // waits for the owner's answer
  if (g.etag && g.etag === link.google_etag) return "skipped"; // Hydra's own write coming back
  const row = await loadItem(ctx.db, link.item_kind, link.item_id);
  if (!row) return "skipped"; // deleted in Hydra: removeFromGoogle owns the Google side
  if (Date.parse(row.updated_at) > Date.parse(g.updated ?? "")) {
    await push(ctx, link.item_kind, link.item_id, link); // Hydra's edit is the last one
    return "pushed";
  }
  const patch = link.item_kind === "task" ? taskFromGoogle(g, ctx.timeZone) : eventFromGoogle(g, ctx.timeZone);
  must(link.item_kind, await ctx.db.from(TABLE[link.item_kind]).update(patch).eq("id", link.item_id));
  await saveLink(ctx, link.item_kind, link.item_id, g);
  return "updated";
}

/** Pull what changed in the Hydra calendar since the last pull and apply it (conflict rule above). */
export async function pullCalendar(): Promise<GoogleResult<PullSummary>> {
  return run(async () => {
    const summary: PullSummary = { connected: false, fullSync: false, created: 0, updated: 0, pushed: 0, pendingDeletes: 0, skipped: 0 };
    const db = createAdminClient();
    const ctx = await context(db);
    if (!ctx) return summary;
    summary.connected = true;
    const state = must("calendar sync", await db.from("google_calendar_sync").select("sync_token").eq("account_id", ctx.accountId).maybeSingle()) as {
      sync_token: string | null;
    } | null;
    const startToken = state?.sync_token ?? null;
    summary.fullSync = startToken === null;
    let changes: Awaited<ReturnType<typeof listChanges>>;
    try {
      changes = await listChanges(ctx, startToken);
    } catch (error) {
      if (!(error instanceof GoogleApiError && error.status === 410 && startToken)) throw error;
      summary.fullSync = true; // the token expired: Google asks for a full sync
      changes = await listChanges(ctx, null);
    }
    for (const g of changes.items) summary[await applyRemote(ctx, g)]++;
    // Compare-and-set: only move the token on from the one this pull started at.
    const update = db
      .from("google_calendar_sync")
      .update({ sync_token: changes.nextSyncToken, last_pulled_at: new Date().toISOString() })
      .eq("account_id", ctx.accountId);
    must("calendar sync", await (startToken === null ? update.is("sync_token", null) : update.eq("sync_token", startToken)));
    return summary;
  });
}

// ---------------------------------------------------------------------------
// Deletes ask
// ---------------------------------------------------------------------------

export interface PendingDelete {
  linkId: string;
  kind: ItemKind;
  itemId: string;
  title: string;
}

/** Items whose Google event was deleted, waiting for the owner's yes or no. */
export async function listPendingDeletes(): Promise<GoogleResult<PendingDelete[]>> {
  return run(async () => {
    const db = createAdminClient();
    const links = (must("calendar links", await db.from("google_calendar_links").select(LINK_COLUMNS).eq("pending", "delete_in_hydra")) ?? []) as LinkRow[];
    const out: PendingDelete[] = [];
    for (const l of links) {
      const row = await loadItem(db, l.item_kind, l.item_id);
      if (row) out.push({ linkId: l.id, kind: l.item_kind, itemId: l.item_id, title: row.title });
    }
    return out;
  });
}

async function pendingLink(db: SupabaseClient, linkId: string): Promise<LinkRow> {
  const link = must("calendar link", await db.from("google_calendar_links").select(LINK_COLUMNS).eq("id", linkId).eq("pending", "delete_in_hydra").maybeSingle()) as LinkRow | null;
  if (!link) throw new GoogleError("not_found", "Nothing is waiting on that delete");
  return link;
}

/** Yes: delete the Hydra item too. Needs the confirm gate's approval id. */
export async function confirmPendingDelete(linkId: string, approvalId: string): Promise<GoogleResult<{ deleted: true }>> {
  return run(async () => {
    const db = createAdminClient();
    await requireApproval(approvalId, db);
    const link = await pendingLink(db, linkId);
    must(link.item_kind, await db.from(TABLE[link.item_kind]).delete().eq("id", link.item_id));
    must("calendar link", await db.from("google_calendar_links").delete().eq("id", link.id));
    return { deleted: true as const };
  });
}

/**
 * No: keep the Hydra item and put it back on the Hydra calendar. An item with nothing to put there
 * (a task with no due date) drops the waiting link, so it syncs again once it has a date.
 */
export async function keepPendingDelete(linkId: string): Promise<GoogleResult<PushOutcome>> {
  return run(async () => {
    const db = createAdminClient();
    const link = await pendingLink(db, linkId);
    const ctx = await context(db);
    // Keep means "put it back on the calendar": without Google that did not happen, so it is a refusal.
    if (!ctx) throw new GoogleError("not_connected", "Connect Google first");
    const out = await push(ctx, link.item_kind, link.item_id, null, true);
    if (out === "skipped" || out === "not_found") {
      must("calendar link", await db.from("google_calendar_links").delete().eq("id", link.id));
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Watch channel (push notifications)
// ---------------------------------------------------------------------------

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function watch(ctx: Ctx, address: string) {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const channel = await googleApi<{ resourceId: string; expiration?: string }>(
    `${eventsUrl(ctx)}/watch`,
    { method: "POST", body: { id, type: "web_hook", address, token, params: { ttl: String(WATCH_TTL_S) } } },
    ctx.db,
  );
  const expiresAt = new Date(channel.expiration ? Number(channel.expiration) : Date.now() + WATCH_TTL_S * 1000).toISOString();
  must(
    "watch channel",
    await ctx.db.from("google_watch_channels").insert({
      id,
      account_id: ctx.accountId,
      resource_id: channel.resourceId,
      token_hash: sha256(token),
      address,
      expires_at: expiresAt,
    }),
  );
  return { channelId: id, expiresAt };
}

/** Ask Google to call `address` (https, this app's webhook route) when the Hydra calendar changes. */
export async function startWatch(address: string): Promise<GoogleResult<{ channelId: string; expiresAt: string }>> {
  return run(async () => {
    if (!address.startsWith("https://")) throw new GoogleError("invalid_input", "Google only calls https addresses");
    const ctx = await context(createAdminClient());
    if (!ctx) throw new GoogleError("not_connected", "Connect Google first");
    return watch(ctx, address);
  });
}

/** For the daily cron: replace each channel that expires within a day, then stop the old one. */
export async function renewWatch(): Promise<GoogleResult<{ renewed: number }>> {
  return run(async () => {
    const db = createAdminClient();
    const ctx = await context(db);
    if (!ctx) return { renewed: 0 };
    const channels = (must("watch channels", await db.from("google_watch_channels").select("id, resource_id, address, expires_at").eq("account_id", ctx.accountId)) ??
      []) as { id: string; resource_id: string; address: string; expires_at: string }[];
    let renewed = 0;
    for (const c of channels.filter((c) => Date.parse(c.expires_at) - Date.now() < RENEW_BEFORE_MS)) {
      await watch(ctx, c.address);
      try {
        await googleApi(`${API}/channels/stop`, { method: "POST", body: { id: c.id, resourceId: c.resource_id } }, db);
      } catch (error) {
        if (!isGone(error)) throw error;
      }
      must("watch channel", await db.from("google_watch_channels").delete().eq("id", c.id));
      renewed++;
    }
    return { renewed };
  });
}

/**
 * Check a push notification: a channel Hydra made, the same watched resource, and the channel's
 * secret token (compared by hash, constant time). Google sends no body; the headers are all there is.
 */
export async function verifyNotification(headers: Headers): Promise<{ ok: false } | { ok: true; state: string }> {
  const id = headers.get("x-goog-channel-id");
  const token = headers.get("x-goog-channel-token");
  const resource = headers.get("x-goog-resource-id");
  if (!id || !token || !resource) return { ok: false };
  const channel = must(
    "watch channel",
    await createAdminClient().from("google_watch_channels").select("token_hash, resource_id").eq("id", id).maybeSingle(),
  ) as { token_hash: string; resource_id: string } | null;
  if (!channel || channel.resource_id !== resource) return { ok: false };
  const [got, want] = [Buffer.from(sha256(token), "hex"), Buffer.from(channel.token_hash, "hex")];
  return got.length === want.length && timingSafeEqual(got, want) ? { ok: true, state: headers.get("x-goog-resource-state") ?? "" } : { ok: false };
}
