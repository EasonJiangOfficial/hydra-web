/**
 * Test support for the Google connector: a small in-memory stand-in for the supabase-js client
 * (enough of PostgREST for src/lib/google) and a fake Google (OAuth, Calendar) behind `fetch`.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Reply = { data: unknown; error: { code?: string; message: string } | null };

const CASCADE: Record<string, string[]> = {
  google_accounts: ["google_calendar_sync", "google_calendar_links", "google_watch_channels"],
};

/** Rows by table. Inserts get an id and timestamps; updates bump updated_at (the touch trigger). */
export function memoryDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
  const rows = (t: string) => (tables[t] ??= []);
  const stamp = () => new Date().toISOString();

  function exec(table: string, q: Query): Reply {
    const match = (r: Row) => q.filters.every((f) => f(r));
    const list = rows(table);
    let out: Row[];
    if (q.action === "select") out = list.filter(match);
    else if (q.action === "insert") {
      out = ([] as Row[]).concat(q.values as Row).map((v) => ({ id: randomUUID(), created_at: stamp(), updated_at: stamp(), ...v }));
      list.push(...out);
    } else if (q.action === "update") {
      out = list.filter(match);
      for (const r of out) Object.assign(r, q.values, "updated_at" in r ? { updated_at: stamp() } : {});
    } else if (q.action === "upsert") {
      const keys = (q.onConflict ?? "id").split(",");
      out = ([] as Row[]).concat(q.values as Row).map((v) => {
        const hit = list.find((r) => keys.every((k) => r[k] === v[k]));
        if (hit) return Object.assign(hit, v, { updated_at: stamp() });
        const row = { id: randomUUID(), created_at: stamp(), updated_at: stamp(), ...v };
        list.push(row);
        return row;
      });
    } else {
      out = list.filter(match);
      tables[table] = list.filter((r) => !out.includes(r));
      for (const child of CASCADE[table] ?? []) tables[child] = rows(child).filter((r) => !out.some((p) => p.id === r.account_id));
    }
    if (q.single === "single" && out.length !== 1) return { data: null, error: { message: `${table}: expected one row, got ${out.length}` } };
    const copy = out.map((r) => ({ ...r }));
    if (q.single) return { data: copy[0] ?? null, error: null };
    return { data: q.action === "select" || q.returning ? copy : null, error: null };
  }

  interface Query {
    action: "select" | "insert" | "update" | "upsert" | "delete";
    values?: unknown;
    onConflict?: string;
    filters: ((r: Row) => boolean)[];
    returning: boolean;
    single: "single" | "maybe" | null;
  }

  const client = {
    from(table: string) {
      const q: Query = { action: "select", filters: [], returning: false, single: null };
      const b: Record<string, unknown> = {
        select: () => ((q.returning = q.action !== "select"), b),
        insert: (v: unknown) => ((q.action = "insert"), (q.values = v), b),
        update: (v: unknown) => ((q.action = "update"), (q.values = v), b),
        upsert: (v: unknown, o?: { onConflict?: string }) => ((q.action = "upsert"), (q.values = v), (q.onConflict = o?.onConflict), b),
        delete: () => ((q.action = "delete"), b),
        eq: (c: string, v: unknown) => (q.filters.push((r) => r[c] === v), b),
        is: (c: string, v: unknown) => (q.filters.push((r) => (r[c] ?? null) === v), b),
        gte: (c: string, v: unknown) => (q.filters.push((r) => r[c] != null && String(r[c]) >= String(v)), b),
        lt: (c: string, v: unknown) => (q.filters.push((r) => r[c] != null && String(r[c]) < String(v)), b),
        in: (c: string, vs: unknown[]) => (q.filters.push((r) => vs.includes(r[c])), b),
        range: () => b,
        limit: () => b,
        order: () => b,
        maybeSingle: () => ((q.single = "maybe"), b),
        single: () => ((q.single = "single"), b),
        then: (resolve: (r: Reply) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(() => exec(table, q)).then(resolve, reject),
      };
      return b;
    },
  };
  return { db: client as unknown as SupabaseClient, tables, rows };
}

// ---------------------------------------------------------------------------
// Fake Google
// ---------------------------------------------------------------------------

export interface FakeEvent {
  id: string;
  status: string;
  etag: string;
  updated: string;
  version: number;
  [key: string]: unknown;
}

export interface Call {
  method: string;
  url: URL;
  body: unknown;
  auth: string | null;
}

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Google behind `fetch`: the token endpoint, userinfo, revoke, and one calendar with events, sync
 * tokens (a version counter) and watch channels. `extra` answers anything else (Gmail).
 */
export function fakeGoogle(extra?: (call: Call) => Response | undefined) {
  const state = {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    refreshFails: false,
    issued: 1,
    version: 0,
    expiredSyncTokens: new Set<string>(),
    calendarId: null as string | null,
    events: new Map<string, FakeEvent>(),
  };
  const calls: Call[] = [];

  const save = (e: { id: string } & Record<string, unknown>) => {
    const version = ++state.version;
    const saved = { ...e, version, etag: `"etag-${version}"`, updated: new Date().toISOString() } as FakeEvent;
    state.events.set(e.id, saved);
    return saved;
  };
  const view = (e: FakeEvent) => {
    const { version: _v, ...rest } = e;
    void _v;
    return rest;
  };

  async function fetchImpl(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const raw = init.body === undefined || init.body === null ? undefined : String(init.body);
    const body =
      raw === undefined ? undefined : headers.get("content-type")?.includes("json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    const call: Call = { method, url, body, auth: headers.get("authorization") };
    calls.push(call);
    const path = url.pathname;

    if (url.host === "oauth2.googleapis.com" && path === "/token") {
      const p = body as Record<string, string>;
      if (p.grant_type === "authorization_code") {
        if (p.code !== "good-code" || !p.code_verifier) return json(400, { error: "invalid_grant" });
        return json(200, { access_token: state.accessToken, expires_in: 3600, refresh_token: state.refreshToken, scope: "openid email" });
      }
      if (state.refreshFails || p.refresh_token !== state.refreshToken) return json(400, { error: "invalid_grant" });
      state.accessToken = `access-${++state.issued}`;
      return json(200, { access_token: state.accessToken, expires_in: 3600 });
    }
    if (url.host === "oauth2.googleapis.com" && path === "/revoke") return json(200, {});
    if (call.auth !== `Bearer ${state.accessToken}`) return json(401, { error: { status: "UNAUTHENTICATED" } });
    if (url.host === "openidconnect.googleapis.com") return json(200, { email: "Owner@Example.test" });

    const cal = path.match(/^\/calendar\/v3\/calendars(?:\/([^/]+)\/events(?:\/([^/]+))?)?$/);
    if (cal && !cal[1] && method === "POST") {
      state.calendarId = "hydra-cal";
      return json(200, { id: state.calendarId, summary: (body as { summary: string }).summary });
    }
    if (path === "/calendar/v3/channels/stop") return json(204);
    if (cal && cal[1]) {
      const [, , eventId] = cal;
      if (eventId === "watch") {
        const b = body as { id: string; params: { ttl: string } };
        return json(200, { id: b.id, resourceId: "resource-1", expiration: String(Date.now() + Number(b.params.ttl) * 1000) });
      }
      if (!eventId && method === "POST") {
        const asked = (body as { id?: string }).id;
        if (asked && state.events.has(asked)) return json(409, { error: { errors: [{ reason: "duplicate" }] } });
        return json(200, view(save({ status: "confirmed", ...(body as object), id: asked ?? `g${state.events.size + 1}` })));
      }
      if (!eventId && method === "GET") {
        const token = url.searchParams.get("syncToken");
        if (token && state.expiredSyncTokens.has(token)) return json(410, { error: { errors: [{ reason: "fullSyncRequired" }] } });
        const all = [...state.events.values()].filter((e) => (token ? e.version > Number(token) : e.status !== "cancelled"));
        const offset = Number(url.searchParams.get("pageToken") ?? 0);
        const size = Number(url.searchParams.get("maxResults") ?? 250);
        const page = all.slice(offset, offset + size);
        const more = offset + size < all.length;
        return json(200, { items: page.map(view), ...(more ? { nextPageToken: String(offset + size) } : { nextSyncToken: String(state.version) }) });
      }
      const existing = state.events.get(eventId!);
      if (!existing || existing.status === "cancelled") return json(410, { error: { errors: [{ reason: "deleted" }] } });
      if (method === "PATCH") return json(200, view(save({ ...existing, ...(body as object) })));
      if (method === "DELETE") {
        save({ ...existing, status: "cancelled" });
        return json(204);
      }
    }
    return extra?.(call) ?? json(404, { error: { errors: [{ reason: "notFound" }] } });
  }

  return {
    state,
    calls,
    fetch: fetchImpl,
    /** An edit made in Google Calendar by the owner. */
    edit: (id: string, patch: Record<string, unknown>) => save({ ...state.events.get(id)!, ...patch }),
    /** An event the owner made in Google Calendar, on the Hydra calendar. */
    create: (fields: Record<string, unknown>) => save({ id: `g${state.events.size + 1}`, status: "confirmed", ...fields }),
    /** The owner deleted it in Google Calendar. */
    remove: (id: string) => save({ ...state.events.get(id)!, status: "cancelled" }),
  };
}
