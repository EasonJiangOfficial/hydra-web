// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptToken } from "@/lib/bank/crypto";
import { fakeGoogle, memoryDb } from "./fixtures";

const mocks = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));

const cal = await import("./calendar");

const ACCOUNT = "aaaaaaaa-0000-4000-8000-000000000001";
const TASK = "bbbbbbbb-0000-4000-8000-000000000001";
const UNDATED = "bbbbbbbb-0000-4000-8000-000000000002";
const EVENT = "cccccccc-0000-4000-8000-000000000001";
const TASK_G = cal.googleIdFor("task", TASK);
const EVENT_G = cal.googleIdFor("event", EVENT);
const YES = "dddddddd-0000-4000-8000-000000000001";
const PENDING_YES = "dddddddd-0000-4000-8000-000000000002";
const at = (hhmm: string) => vi.setSystemTime(new Date(`2026-11-21T${hhmm}:00Z`));

let google: ReturnType<typeof fakeGoogle>;
let store: ReturnType<typeof memoryDb>;

function setup(withAccount = true) {
  at("09:00");
  store = memoryDb({
    settings: [{ time_zone: "America/Toronto" }],
    agent_approvals: [
      { id: YES, status: "approved" },
      { id: PENDING_YES, status: "pending" },
    ],
    google_accounts: withAccount
      ? [
          {
            id: ACCOUNT,
            email: "owner@example.test",
            scopes: "",
            status: "active",
            access_token: encryptToken("access-1", ACCOUNT),
            access_expires_at: "2026-11-21T20:00:00Z",
            refresh_token: encryptToken("refresh-1", ACCOUNT),
          },
        ]
      : [],
    planning_tasks: [
      { id: TASK, title: "Send the W-9", notes: "to Brand Co", due_date: "2026-11-24", updated_at: "2026-11-21T09:00:00Z" },
      { id: UNDATED, title: "Someday", notes: "", due_date: null, updated_at: "2026-11-21T09:00:00Z" },
    ],
    events: [
      {
        id: EVENT,
        title: "Dentist",
        starts_at: "2026-11-25T15:00:00.000Z",
        ends_at: "2026-11-25T16:00:00.000Z",
        all_day: false,
        repeat: null,
        notes: "",
        google_event_id: null,
        updated_at: "2026-11-21T09:00:00Z",
      },
    ],
  });
  mocks.db = store.db;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
  vi.stubEnv("HYDRA_TOKEN_KEY", Buffer.alloc(32, 7).toString("base64"));
  google = fakeGoogle();
  vi.stubGlobal("fetch", vi.fn(google.fetch));
  setup();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const listings = () => google.calls.filter((c) => c.method === "GET" && c.url.pathname.endsWith("/events"));
const hydraEvent = (id = EVENT) => store.rows("events").find((e) => e.id === id)!;

describe("push on write", () => {
  it("puts a dated task on the Hydra calendar as an all-day event and links it", async () => {
    expect(await cal.pushToGoogle("task", TASK)).toEqual({ ok: true, data: "created" });
    const g = google.state.events.get(TASK_G)!;
    expect(g).toMatchObject({
      summary: "Send the W-9",
      description: "to Brand Co",
      start: { date: "2026-11-24" },
      end: { date: "2026-11-25" },
      extendedProperties: { private: { hydraKind: "task", hydraId: TASK } },
    });
    expect(store.rows("google_calendar_sync")).toEqual([expect.objectContaining({ account_id: ACCOUNT, calendar_id: "hydra-cal" })]);
    expect(store.rows("google_calendar_links")).toEqual([
      expect.objectContaining({ item_kind: "task", item_id: TASK, google_event_id: TASK_G, google_etag: g.etag, pending: null }),
    ]);

    expect(await cal.pushToGoogle("task", TASK)).toEqual({ ok: true, data: "updated" });
    expect(google.calls.filter((c) => c.method === "POST" && c.url.pathname === "/calendar/v3/calendars")).toHaveLength(1);
    expect(await cal.pushToGoogle("task", UNDATED)).toEqual({ ok: true, data: "skipped" });
  });

  it("a second create of the same item (a racing push, a lost link) patches the one event", async () => {
    await cal.pushToGoogle("task", TASK);
    store.tables.google_calendar_links = [];
    expect(await cal.pushToGoogle("task", TASK)).toEqual({ ok: true, data: "created" });
    expect(google.calls.some((c) => c.method === "PATCH" && c.url.pathname.endsWith(`/events/${TASK_G}`))).toBe(true);
    expect(google.state.events.size).toBe(1);
    expect(store.rows("google_calendar_links")).toEqual([expect.objectContaining({ item_id: TASK, google_event_id: TASK_G })]);
  });

  it("two pushes racing past a deleted copy make one new event, on the next fixed id", async () => {
    await cal.pushToGoogle("task", TASK);
    google.remove(TASK_G); // Google keeps the deleted id: a POST with it is 409
    store.tables.google_calendar_links = []; // no link says it is live (Hydra removed it, or the task was kept undated)
    const results = await Promise.all([cal.pushToGoogle("task", TASK), cal.pushToGoogle("task", TASK)]);
    expect(results).toEqual([
      { ok: true, data: "created" },
      { ok: true, data: "created" },
    ]);
    const live = [...google.state.events.values()].filter((e) => e.status !== "cancelled");
    expect(live.map((e) => e.id)).toEqual([cal.googleIdFor("task", TASK, 1)]);
    expect(store.rows("google_calendar_links")).toEqual([expect.objectContaining({ google_event_id: cal.googleIdFor("task", TASK, 1) })]);
    expect(cal.googleIdFor("task", TASK, 1)).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  it("writes a timed event with its zone and records the Google id on the event row", async () => {
    expect(await cal.pushToGoogle("event", EVENT)).toEqual({ ok: true, data: "created" });
    expect(google.state.events.get(EVENT_G)).toMatchObject({
      start: { dateTime: "2026-11-25T15:00:00.000Z", timeZone: "America/Toronto" },
      end: { dateTime: "2026-11-25T16:00:00.000Z", timeZone: "America/Toronto" },
      recurrence: [],
    });
    expect(hydraEvent().google_event_id).toBe(EVENT_G);
  });

  it("removes the Google copy after a confirmed Hydra delete", async () => {
    await cal.pushToGoogle("event", EVENT);
    store.tables.events = [];
    expect(await cal.removeFromGoogle("event", EVENT)).toEqual({ ok: true, data: "removed" });
    expect(google.state.events.get(EVENT_G)!.status).toBe("cancelled");
    expect(store.rows("google_calendar_links")).toEqual([]);
  });

  it("is a no-op without a Google sign-in, and fails closed without the client env", async () => {
    setup(false);
    expect(await cal.pushToGoogle("task", TASK)).toEqual({ ok: true, data: "not_connected" });
    expect(google.calls).toEqual([]);

    setup(true);
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    const r = await cal.pushToGoogle("task", TASK);
    expect(r).toMatchObject({ ok: false, error: { code: "not_configured" } });
    expect(google.calls).toEqual([]);
  });
});

describe("pull with a sync token", () => {
  it("round trip: push, full pull, Google edits and adds, incremental pull with the stored token", async () => {
    at("10:00");
    await cal.pushToGoogle("event", EVENT);
    at("10:01");
    const first = await cal.pullCalendar();
    expect(first).toMatchObject({ ok: true, data: { connected: true, fullSync: true, skipped: 1, created: 0, updated: 0 } });
    expect(listings()[0].url.searchParams.has("syncToken")).toBe(false);
    const token = store.rows("google_calendar_sync")[0].sync_token as string;
    expect(token).toBe(String(google.state.version));

    at("10:05");
    google.edit(EVENT_G, {
      summary: "Dentist (moved)",
      start: { dateTime: "2026-11-26T15:00:00Z" },
      end: { dateTime: "2026-11-26T16:30:00Z" },
    });
    google.create({ summary: "Brand call", start: { date: "2026-11-27" }, end: { date: "2026-11-28" } });

    at("10:06");
    const second = await cal.pullCalendar();
    expect(second).toMatchObject({ ok: true, data: { fullSync: false, updated: 1, created: 1, pendingDeletes: 0 } });
    expect(listings()[1].url.searchParams.get("syncToken")).toBe(token);
    expect(hydraEvent()).toMatchObject({
      title: "Dentist (moved)",
      starts_at: "2026-11-26T15:00:00.000Z",
      ends_at: "2026-11-26T16:30:00.000Z",
      all_day: false,
    });
    const imported = store.rows("events").find((e) => e.google_event_id === "g2")!;
    expect(imported).toMatchObject({ title: "Brand call", all_day: true, starts_at: "2026-11-27T05:00:00.000Z", ends_at: null });
    expect(store.rows("google_calendar_links")).toContainEqual(expect.objectContaining({ item_kind: "event", item_id: imported.id, google_event_id: "g2" }));
    const next = store.rows("google_calendar_sync")[0].sync_token;
    expect(next).toBe(String(google.state.version));

    const third = await cal.pullCalendar();
    expect(third).toMatchObject({ ok: true, data: { created: 0, updated: 0, pushed: 0, skipped: 0 } });
    expect(listings()[2].url.searchParams.get("syncToken")).toBe(next);
  });

  it("does a full sync when Google says the token expired (410)", async () => {
    await cal.pushToGoogle("event", EVENT);
    await cal.pullCalendar();
    const token = store.rows("google_calendar_sync")[0].sync_token as string;
    google.state.expiredSyncTokens.add(token);
    const r = await cal.pullCalendar();
    expect(r).toMatchObject({ ok: true, data: { fullSync: true } });
    expect(listings().at(-1)!.url.searchParams.has("syncToken")).toBe(false);
  });

  it("does not move the token when another pull moved it first (compare-and-set)", async () => {
    await cal.pushToGoogle("event", EVENT);
    await cal.pullCalendar();
    const fetchImpl = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const res = await fetchImpl(input, init);
      if (String(input).includes("/events?")) store.rows("google_calendar_sync")[0].sync_token = "moved-by-another-pull";
      return res;
    });
    google.create({ summary: "x", start: { date: "2026-11-30" }, end: { date: "2026-12-01" } });
    await cal.pullCalendar();
    expect(store.rows("google_calendar_sync")[0].sync_token).toBe("moved-by-another-pull");
  });
});

describe("conflict rule: last edit wins", () => {
  it("a Hydra edit made after the Google edit is pushed back over it", async () => {
    at("10:00");
    await cal.pushToGoogle("event", EVENT);
    await cal.pullCalendar();
    at("10:05");
    google.edit(EVENT_G, { summary: "Google title" });
    at("10:10");
    await store.db.from("events").update({ title: "Hydra title" }).eq("id", EVENT);
    at("10:11");
    expect(await cal.pullCalendar()).toMatchObject({ ok: true, data: { pushed: 1, updated: 0 } });
    expect(google.state.events.get(EVENT_G)!.summary).toBe("Hydra title");
    expect(hydraEvent().title).toBe("Hydra title");
    // Hydra's own write coming back is skipped by its etag.
    expect(await cal.pullCalendar()).toMatchObject({ ok: true, data: { pushed: 0, updated: 0, skipped: 1 } });
  });

  it("a Google edit made after the Hydra edit wins in Hydra", async () => {
    at("10:00");
    await cal.pushToGoogle("task", TASK);
    await cal.pullCalendar();
    at("10:05");
    await store.db.from("planning_tasks").update({ title: "Hydra title" }).eq("id", TASK);
    at("10:10");
    google.edit(TASK_G, { summary: "Google title", start: { date: "2026-11-28" }, end: { date: "2026-11-29" } });
    expect(await cal.pullCalendar()).toMatchObject({ ok: true, data: { updated: 1, pushed: 0 } });
    expect(store.rows("planning_tasks").find((t) => t.id === TASK)).toMatchObject({ title: "Google title", due_date: "2026-11-28" });
  });
});

describe("deletes ask", () => {
  it("a Google delete waits for the owner; yes needs the approval id", async () => {
    await cal.pushToGoogle("event", EVENT);
    await cal.pullCalendar();
    google.remove(EVENT_G);
    expect(await cal.pullCalendar()).toMatchObject({ ok: true, data: { pendingDeletes: 1 } });
    expect(hydraEvent()).toBeDefined();
    expect(await cal.pushToGoogle("event", EVENT)).toEqual({ ok: true, data: "waiting_for_owner" });

    const pending = await cal.listPendingDeletes();
    expect(pending).toMatchObject({ ok: true, data: [{ kind: "event", itemId: EVENT, title: "Dentist" }] });
    const linkId = (pending as { data: { linkId: string }[] }).data[0].linkId;

    for (const approval of ["", "approval-1", PENDING_YES]) {
      expect(await cal.confirmPendingDelete(linkId, approval)).toMatchObject({ ok: false, error: { code: "approval_required" } });
    }
    expect(hydraEvent()).toBeDefined();
    expect(await cal.confirmPendingDelete(linkId, YES)).toEqual({ ok: true, data: { deleted: true } });
    expect(store.rows("events")).toEqual([]);
    expect(store.rows("google_calendar_links")).toEqual([]);
  });

  it("no: keeps the Hydra item and puts it back on the calendar", async () => {
    await cal.pushToGoogle("event", EVENT);
    await cal.pullCalendar();
    google.remove(EVENT_G);
    await cal.pullCalendar();
    const linkId = store.rows("google_calendar_links")[0].id as string;
    expect(await cal.keepPendingDelete(linkId)).toEqual({ ok: true, data: "created" });
    expect(store.rows("google_calendar_links")).toEqual([expect.objectContaining({ google_event_id: "g2", pending: null })]);
    expect(google.state.events.get("g2")!.summary).toBe("Dentist");
  });

  it("no while Google is disconnected is refused, and the delete keeps waiting", async () => {
    await cal.pushToGoogle("event", EVENT);
    await cal.pullCalendar();
    google.remove(EVENT_G);
    await cal.pullCalendar();
    const linkId = store.rows("google_calendar_links")[0].id as string;
    store.tables.google_accounts = [];
    expect(await cal.keepPendingDelete(linkId)).toMatchObject({ ok: false, error: { code: "not_connected" } });
    expect(store.rows("google_calendar_links")).toEqual([expect.objectContaining({ pending: "delete_in_hydra" })]);
  });

  it("no on a task undated meanwhile: the waiting link goes, and the task syncs again once dated", async () => {
    await cal.pushToGoogle("task", TASK);
    await cal.pullCalendar();
    google.remove(TASK_G);
    expect(await cal.pullCalendar()).toMatchObject({ ok: true, data: { pendingDeletes: 1 } });
    store.rows("planning_tasks").find((t) => t.id === TASK)!.due_date = null;
    expect(await cal.pushToGoogle("task", TASK)).toEqual({ ok: true, data: "waiting_for_owner" });
    const linkId = store.rows("google_calendar_links")[0].id as string;
    expect(await cal.keepPendingDelete(linkId)).toEqual({ ok: true, data: "skipped" });
    expect(await cal.listPendingDeletes()).toEqual({ ok: true, data: [] });
    expect(store.rows("google_calendar_links")).toEqual([]);
    store.rows("planning_tasks").find((t) => t.id === TASK)!.due_date = "2026-11-26";
    expect(await cal.pushToGoogle("task", TASK)).toMatchObject({ ok: true, data: expect.stringMatching(/created|updated/) });
    expect(store.rows("google_calendar_links")).toEqual([expect.objectContaining({ pending: null })]);
  });

  it("yes from the Planning page: the owner's own delete there clears the waiting link (the event is already gone)", async () => {
    await cal.pushToGoogle("task", TASK);
    await cal.pullCalendar();
    google.remove(TASK_G);
    expect(await cal.pullCalendar()).toMatchObject({ ok: true, data: { pendingDeletes: 1 } });
    expect(await cal.listPendingDeletes()).toMatchObject({ ok: true, data: [{ kind: "task", itemId: TASK, title: "Send the W-9" }] });
    // The page deletes the task (asked first), then mirrors the delete: Google answers 410 Gone.
    store.tables.planning_tasks = store.rows("planning_tasks").filter((t) => t.id !== TASK);
    expect(await cal.removeFromGoogle("task", TASK)).toEqual({ ok: true, data: "removed" });
    expect(store.rows("google_calendar_links")).toEqual([]);
    expect(await cal.listPendingDeletes()).toEqual({ ok: true, data: [] });
  });

  it("an edit to an event already deleted in Google asks instead of recreating it", async () => {
    await cal.pushToGoogle("event", EVENT);
    google.remove(EVENT_G);
    expect(await cal.pushToGoogle("event", EVENT)).toEqual({ ok: true, data: "waiting_for_owner" });
    expect(store.rows("google_calendar_links")[0].pending).toBe("delete_in_hydra");
  });
});

describe("watch channel", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");

  it("keeps only the token's hash and verifies notifications against it", async () => {
    const r = await cal.startWatch("https://hydra.example/api/google/calendar/webhook");
    expect(r.ok).toBe(true);
    const sent = google.calls.find((c) => c.url.pathname.endsWith("/events/watch"))!.body as { id: string; token: string; address: string };
    const [row] = store.rows("google_watch_channels");
    expect(row).toMatchObject({ id: sent.id, resource_id: "resource-1", token_hash: sha(sent.token), address: sent.address });
    expect(JSON.stringify(row)).not.toContain(sent.token);

    const headers = (over: Record<string, string> = {}) =>
      new Headers({
        "x-goog-channel-id": sent.id,
        "x-goog-channel-token": sent.token,
        "x-goog-resource-id": "resource-1",
        "x-goog-resource-state": "exists",
        ...over,
      });
    expect(await cal.verifyNotification(headers())).toEqual({ ok: true, state: "exists" });
    expect(await cal.verifyNotification(headers({ "x-goog-channel-token": "guess" }))).toEqual({ ok: false });
    expect(await cal.verifyNotification(headers({ "x-goog-channel-id": "other" }))).toEqual({ ok: false });
    expect(await cal.verifyNotification(headers({ "x-goog-resource-id": "other" }))).toEqual({ ok: false });
    expect(await cal.startWatch("http://localhost:3000/x")).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("renews a channel that expires within a day and stops the old one", async () => {
    await cal.startWatch("https://hydra.example/api/google/calendar/webhook");
    const old = store.rows("google_watch_channels")[0].id;
    expect(await cal.renewWatch()).toEqual({ ok: true, data: { renewed: 0 } });
    vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
    expect(await cal.renewWatch()).toEqual({ ok: true, data: { renewed: 1 } });
    expect(store.rows("google_watch_channels").map((c) => c.id)).not.toContain(old);
    expect(store.rows("google_watch_channels")).toHaveLength(1);
    expect(google.calls.some((c) => c.url.pathname === "/calendar/v3/channels/stop" && (c.body as { id: string }).id === old)).toBe(true);
  });
});
