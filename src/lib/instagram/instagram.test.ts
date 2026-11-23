// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptToken, encryptToken } from "@/lib/bank/crypto";
import { MissingEnvError } from "@/lib/bank/env";
import { memoryDb } from "@/lib/google/fixtures";

/**
 * The Instagram connector (Unified Login) against a fake graph.facebook.com behind `fetch` (no call ever leaves
 * the process) and the in-memory supabase stand-in: the code exchange, the shared account, state checks, and the
 * sync's upserts, lease, zone day, throttle and revoked-token paths. Answers follow Meta's documented shapes.
 */

const mocks = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));

const { errorOf, InstagramError, recentMedia, run } = await import("./client");
const { checkState, disconnect, finishSignIn, instagramMissing, startSignIn } = await import("./oauth");
const { syncInstagram } = await import("./sync");
const { instagramEnvNote, instagramErrorNote, instagramNeedsGrant, instagramState } = await import("./model");

const CONN = "cccccccc-0000-4000-8000-000000000205";
/** The Instagram professional account id (GET /me/assigned_instagram_accounts). */
const IG = "17841400000000001";
const CALLBACK = "https://hydra.example/api/instagram/callback";
const NOW = new Date("2026-11-22T03:00:00Z"); // 22:00 on Nov 21 in Toronto
const DAY = 86_400_000;

interface FakeMedia {
  id: string;
  shortcode: string;
  permalink: string;
  media_type: string;
  timestamp: string;
  like_count?: number;
  comments_count?: number;
}

/**
 * graph.facebook.com behind `fetch`: the code exchange, /me/assigned_instagram_accounts, the account's profile,
 * its media (paged) and media insights. `/me` itself is the system user, so it is not served here.
 */
function fakeInstagram() {
  const state = {
    token: "bisu-1",
    /** expires_in on the exchange; null leaves it out (a token that never expires). */
    expiresIn: null as number | null,
    accounts: [{ id: IG, username: "studio.notes" }] as { id: string; username: string }[],
    followers: 1300,
    media: [] as FakeMedia[],
    views: {} as Record<string, number>,
    /** Insights calls that answer before Instagram throttles; null = never. */
    insightsBudget: null as number | null,
    /** An error body every insights call answers with (status 400); null = answer normally. */
    insightsError: null as Record<string, unknown> | null,
    revoked: false,
  };
  const calls: URL[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  async function fetchImpl(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input));
    calls.push(url);
    const q = url.searchParams;
    if (url.host !== "graph.facebook.com" || (init.method ?? "GET") !== "GET") return json(404, {});
    if (url.pathname === "/v27.0/oauth/access_token") {
      const good = q.get("client_id") === "1234567890" && q.get("client_secret") === "app-secret" && q.get("redirect_uri") === CALLBACK && q.get("code") === "good-code";
      if (!good) return json(400, { error: { message: "This authorization code has been used.", type: "OAuthException", code: 100, fbtrace_id: "x" } });
      return json(200, { access_token: state.token, token_type: "bearer", ...(state.expiresIn === null ? {} : { expires_in: state.expiresIn }) });
    }
    const live = !state.revoked && q.get("access_token") === state.token;
    if (!live) return json(400, { error: { message: "Error validating access token", type: "OAuthException", code: 190, fbtrace_id: "x" } });
    if (url.pathname === "/v27.0/me/assigned_instagram_accounts") {
      return json(200, { data: state.accounts, paging: { cursors: { before: "b", after: "a" } } });
    }
    if (url.pathname === `/v27.0/${IG}`) return json(200, { id: IG, username: "studio.notes", followers_count: state.followers });
    if (url.pathname === `/v27.0/${IG}/media`) {
      const size = Number(q.get("limit"));
      const sorted = [...state.media].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
      const at = Number(q.get("after") ?? 0);
      const page = sorted.slice(at, at + size);
      const more = at + size < sorted.length;
      return json(200, { data: page, paging: { cursors: { before: "b", after: more ? String(at + size) : undefined } } });
    }
    const ins = /^\/v27\.0\/([^/]+)\/insights$/.exec(url.pathname);
    if (ins) {
      if (state.insightsError) return json(400, { error: state.insightsError });
      if (state.insightsBudget !== null && state.insightsBudget-- <= 0) return json(403, { error: { code: 80002, message: "throttled" } });
      const views = state.views[ins[1]];
      if (views === undefined) return json(200, { data: [] });
      return json(200, {
        data: [
          { name: "views", period: "lifetime", values: [{ value: views }] },
          { name: "likes", period: "lifetime", values: [{ value: Math.round(views / 10) }] },
          { name: "comments", period: "lifetime", values: [{ value: Math.round(views / 100) }] },
        ],
      });
    }
    return json(400, { error: { message: "Unsupported get request.", type: "GraphMethodException", code: 100 } });
  }
  return { state, calls, fetch: fetchImpl };
}

let ig: ReturnType<typeof fakeInstagram>;
let store: ReturnType<typeof memoryDb>;

const media = (n: number, daysAgo: number, type = "VIDEO"): FakeMedia => ({
  id: `m${n}`,
  shortcode: `Code${n}`,
  permalink: `https://www.instagram.com/reel/Code${n}/`,
  media_type: type,
  timestamp: new Date(NOW.getTime() - daysAgo * DAY).toISOString().replace(".000Z", "+0000"),
  like_count: 5,
  comments_count: 1,
});

const connection = (over: Record<string, unknown> = {}) => ({
  id: CONN,
  one_connection: true,
  ig_user_id: IG,
  username: "studio.notes",
  access_token: encryptToken("bisu-1", CONN),
  token_id: "tttttttt-0000-4000-8000-000000000001",
  scopes: "",
  expires_at: null as string | null,
  last_synced_at: null,
  last_error: null,
  sync_started_at: null,
  updated_at: new Date(NOW.getTime() - DAY).toISOString(),
  ...over,
});

const conn = () => store.rows("instagram_connections")[0];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("META_APP_ID", "1234567890");
  vi.stubEnv("META_APP_SECRET", "app-secret");
  vi.stubEnv("INSTAGRAM_CONFIG_ID", "cfg-777");
  vi.stubEnv("HYDRA_TOKEN_KEY", Buffer.alloc(32, 7).toString("base64"));
  ig = fakeInstagram();
  vi.stubGlobal("fetch", vi.fn(ig.fetch));
  store = memoryDb({ settings: [{ time_zone: "America/Toronto" }], instagram_connections: [] });
  mocks.db = store.db;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sign-in", () => {
  it("sends the owner to the Unified login dialog with the Meta app, the config_id and a fresh state (no scope)", () => {
    const { url, cookie } = startSignIn("https://hydra.example/api/instagram/start", "brand");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://www.facebook.com/dialog/oauth");
    const [state, back] = cookie.split(".");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "1234567890",
      config_id: "cfg-777",
      redirect_uri: CALLBACK,
      response_type: "code",
      state,
    });
    expect(back).toBe("brand");
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(startSignIn("https://hydra.example/api/instagram/start", "brand").cookie).not.toBe(cookie);
  });

  it("fails closed without META_APP_ID, META_APP_SECRET, INSTAGRAM_CONFIG_ID or HYDRA_TOKEN_KEY; old Instagram app names do not count", () => {
    vi.stubEnv("INSTAGRAM_APP_ID", "990602627938098");
    vi.stubEnv("INSTAGRAM_APP_SECRET", "ig-secret");
    const good: Record<string, string> = { META_APP_ID: "1234567890", META_APP_SECRET: "app-secret", INSTAGRAM_CONFIG_ID: "cfg-777", HYDRA_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64") };
    for (const name of Object.keys(good)) {
      vi.stubEnv(name, "");
      expect(() => startSignIn("https://hydra.example/api/instagram/start", "brand"), name).toThrow(MissingEnvError);
      vi.stubEnv(name, good[name]);
    }
    expect(ig.calls).toEqual([]);
  });

  it("checks the callback state against the cookie: wrong, missing and tampered states are refused", () => {
    expect(checkState("state-1.brand", "state-1")).toBe("brand");
    expect(checkState("state-1.settings", "state-1")).toBe("settings");
    expect(checkState("state-1.brand", "state-2")).toBeNull();
    expect(checkState("state-1.brand", null)).toBeNull();
    expect(checkState(undefined, "state-1")).toBeNull();
    expect(checkState("state-1", "state-1")).toBeNull();
    expect(checkState("state-1.elsewhere", "state-1")).toBeNull();
    expect(checkState(".brand", "")).toBeNull();
  });

  it("exchanges the code on graph.facebook.com with the Meta app, finds the shared account (not /me), stores the token sealed, never expiring", async () => {
    expect(await finishSignIn({ code: "good-code", requestUrl: `${CALLBACK}?code=x` })).toEqual({ username: "studio.notes" });
    const [exchange, accounts] = ig.calls;
    expect(exchange.origin + exchange.pathname).toBe("https://graph.facebook.com/v27.0/oauth/access_token");
    expect(Object.fromEntries(exchange.searchParams)).toEqual({ client_id: "1234567890", client_secret: "app-secret", redirect_uri: CALLBACK, code: "good-code" });
    expect(accounts.pathname).toBe("/v27.0/me/assigned_instagram_accounts");
    expect(accounts.searchParams.get("fields")).toBe("id,username");
    expect(ig.calls).toHaveLength(2);
    const row = conn();
    expect(row).toMatchObject({ ig_user_id: IG, username: "studio.notes", last_error: null, scopes: "", expires_at: null });
    expect(row.access_token).toMatch(/^v1\./);
    expect(row.token_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(row)).not.toContain("bisu-1");
    expect(decryptToken(row.access_token as string, row.id as string)).toBe("bisu-1");
  });

  it("a configuration with a 60-day token stores its expiry; expires_in 0 is a token that never expires", async () => {
    ig.state.expiresIn = 5_184_000;
    await finishSignIn({ code: "good-code", requestUrl: CALLBACK });
    expect(conn().expires_at).toBe(new Date(NOW.getTime() + 5_184_000_000).toISOString());
    ig.state.expiresIn = 0;
    await finishSignIn({ code: "good-code", requestUrl: CALLBACK });
    expect(conn().expires_at).toBeNull();
  });

  it("more than one shared account keeps the first and logs the count; none is refused and nothing is stored", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ig.state.accounts = [{ id: IG, username: "studio.notes" }, { id: "17841400000000002", username: "other" }];
    await finishSignIn({ code: "good-code", requestUrl: CALLBACK });
    expect(conn()).toMatchObject({ ig_user_id: IG, username: "studio.notes" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("2 Instagram accounts"));
    warn.mockRestore();
    store.tables.instagram_connections = [];
    ig.state.accounts = [];
    expect(await run(() => finishSignIn({ code: "good-code", requestUrl: CALLBACK }))).toMatchObject({ ok: false, error: { code: "instagram_error" } });
    expect(store.rows("instagram_connections")).toEqual([]);
  });

  it("the shared-account read refused for a permission asks for a new sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
        new URL(String(input)).pathname === "/v27.0/me/assigned_instagram_accounts"
          ? new Response(JSON.stringify({ error: { message: "(#10) App is missing the instagram_basic permission", type: "OAuthException", code: 10 } }), { status: 400 })
          : ig.fetch(input, init),
      ),
    );
    expect(await run(() => finishSignIn({ code: "good-code", requestUrl: CALLBACK }))).toMatchObject({ ok: false, error: { code: "reauth_required" } });
    expect(store.rows("instagram_connections")).toEqual([]);
  });

  it("a reconnect updates the one row, gives the new token a new token_id and clears its error", async () => {
    store.rows("instagram_connections").push(connection({ last_error: "reauth_required", access_token: encryptToken("dead", CONN) }));
    await finishSignIn({ code: "good-code", requestUrl: CALLBACK });
    expect(store.rows("instagram_connections")).toHaveLength(1);
    expect(conn()).toMatchObject({ id: CONN, last_error: null });
    expect(conn().token_id).not.toBe(connection().token_id);
    expect(decryptToken(conn().access_token as string, CONN)).toBe("bisu-1");
  });

  it("a used or wrong code is refused and nothing is stored", async () => {
    const r = await run(() => finishSignIn({ code: "used-code", requestUrl: CALLBACK }));
    expect(r).toMatchObject({ ok: false, error: { code: "instagram_error" } });
    expect(store.rows("instagram_connections")).toEqual([]);
  });

  it("sorts Graph's errors: 190 and 102 are a dead token; 4, 17, 32, 341, 613, 80002 and 429 a throttle", () => {
    expect(errorOf(400, { error: { code: 190, type: "OAuthException" } }).code).toBe("reauth_required");
    expect(errorOf(400, { error: { code: 190, error_subcode: 460, type: "OAuthException" } }).code).toBe("reauth_required");
    expect(errorOf(400, { error: { code: 102, type: "OAuthException" } }).code).toBe("reauth_required");
    expect(errorOf(401, {}).code).toBe("reauth_required");
    for (const code of [4, 17, 32, 341, 613, 80002]) expect(errorOf(403, { error: { code } }).code, String(code)).toBe("rate_limited");
    expect(errorOf(429, {}).code).toBe("rate_limited");
    expect(errorOf(400, { error: { code: 100, type: "OAuthException" } }).code).toBe("instagram_error");
    // A refused permission (10, 200-299) is marked, not a sign-in by itself: one media's #10 is that post's.
    expect(errorOf(400, { error: { code: 10, message: "Application does not have permission for this action" } })).toMatchObject({ code: "instagram_error", permission: true });
    expect(errorOf(403, { error: { code: 200 } })).toMatchObject({ code: "instagram_error", permission: true });
    expect(errorOf(400, { error: { code: 190 } }).permission).toBe(false);
    expect(errorOf(401, { error: { code: 10 } }).permission).toBe(false);
    expect(errorOf(400, { error: { code: 100 } }).code).toBe("instagram_error");
  });

  it("names only the variables the host still needs, and shows Connect off until none are left", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const all = { META_APP_ID: "1", META_APP_SECRET: "s", INSTAGRAM_CONFIG_ID: "c", HYDRA_TOKEN_KEY: key };
    expect(instagramMissing(all)).toEqual([]);
    expect(instagramMissing({ ...all, META_APP_SECRET: " " })).toEqual(["META_APP_SECRET"]);
    expect(instagramMissing({ ...all, INSTAGRAM_CONFIG_ID: undefined })).toEqual(["INSTAGRAM_CONFIG_ID"]);
    expect(instagramMissing({ ...all, HYDRA_TOKEN_KEY: "short" })).toEqual(["HYDRA_TOKEN_KEY"]);
    // The old Instagram app names stand in for nothing.
    expect(instagramMissing({ INSTAGRAM_APP_ID: "1", INSTAGRAM_APP_SECRET: "s" })).toEqual(["META_APP_ID", "META_APP_SECRET", "INSTAGRAM_CONFIG_ID", "HYDRA_TOKEN_KEY"]);
    expect(instagramEnvNote(["HYDRA_TOKEN_KEY"])).toBe("Instagram is not set up yet. Add HYDRA_TOKEN_KEY on the host.");
    expect(instagramEnvNote(["INSTAGRAM_CONFIG_ID", "HYDRA_TOKEN_KEY"])).toBe("Instagram is not set up yet. Add INSTAGRAM_CONFIG_ID and HYDRA_TOKEN_KEY on the host.");
    expect(instagramEnvNote(["META_APP_ID", "META_APP_SECRET", "INSTAGRAM_CONFIG_ID", "HYDRA_TOKEN_KEY"])).toBe(
      "Instagram is not set up yet. Add META_APP_ID, META_APP_SECRET, INSTAGRAM_CONFIG_ID and HYDRA_TOKEN_KEY on the host.",
    );
    const view = { username: null, lastSyncedAt: null, lastError: null };
    expect(instagramState({ ...view, missing: ["HYDRA_TOKEN_KEY"] })).toBe("off");
    expect(instagramState({ ...view, missing: [] })).toBe("none");
  });

  it("disconnect deletes the token row; posts and follower counts stay", async () => {
    store.rows("instagram_connections").push(connection());
    store.rows("posts").push({ id: "p1", deal_id: "d1", platform: "INSTAGRAM", url: "https://instagram.com/reel/X" });
    store.rows("personal_brand_followers").push({ day: "2026-11-21", followers: 1200, source: "instagram" });
    expect(await disconnect()).toEqual({ disconnected: true });
    expect(store.rows("instagram_connections")).toEqual([]);
    expect(store.rows("posts")).toHaveLength(1);
    expect(store.rows("personal_brand_followers")).toHaveLength(1);
    expect(await disconnect()).toEqual({ disconnected: false });
    expect(ig.calls).toEqual([]);
  });
});

describe("sync", () => {
  beforeEach(() => {
    store.rows("instagram_connections").push(connection());
    ig.state.media = [media(1, 1), media(2, 3, "IMAGE"), media(3, 40), media(4, 200)]; // m4 is older than 120 days
    ig.state.views = { m1: 5000, m2: 800, m3: 12000, m4: 99 };
  });

  it("first run: makes the Personal Brand deal, the posts, today's readings and the follower count in the owner's zone", async () => {
    const r = await syncInstagram(store.db, NOW);
    expect(r).toMatchObject({ username: "studio.notes", day: "2026-11-21", followers: 1300, media: 3, postsAdded: 3, readings: 3, skipped: 0, cut: false });
    const [deal] = store.rows("deals");
    expect(deal).toMatchObject({ brand_name: "Personal Brand", personal_brand: true, start_date: "2026-11-21" });
    expect(store.rows("deal_accounts")).toEqual([expect.objectContaining({ deal_id: deal.id, platform: "INSTAGRAM", handle: "studio.notes" })]);
    expect(store.rows("posts").map((p) => p.url).sort()).toEqual(["https://instagram.com/reel/Code1", "https://instagram.com/reel/Code2", "https://instagram.com/reel/Code3"]);
    expect(store.rows("posts").every((p) => p.deal_id === deal.id && p.source === "hydra")).toBe(true);
    expect(store.rows("posts").find((p) => p.url === "https://instagram.com/reel/Code1")?.posted_at).toBe(new Date(NOW.getTime() - DAY).toISOString());
    const snaps = store.rows("post_view_snapshots");
    expect(snaps).toHaveLength(3);
    expect(snaps.every((s) => s.captured_day === "2026-11-21" && s.held === false)).toBe(true);
    const m3 = store.rows("posts").find((p) => String(p.url).endsWith("Code3"))!;
    expect(snaps.find((s) => s.post_id === m3.id)).toMatchObject({ views: 12000, likes: 1200, comments: 120 });
    expect(store.rows("personal_brand_followers")).toEqual([expect.objectContaining({ day: "2026-11-21", followers: 1300, source: "instagram" })]);
    expect(conn()).toMatchObject({ last_synced_at: NOW.toISOString(), last_error: null, sync_started_at: null });
    // Never a token in a stored row.
    expect(JSON.stringify(store.tables)).not.toContain("bisu-1");
    // Every read names the account id on graph.facebook.com; /me (the system user) is never the account.
    expect(ig.calls.every((u) => u.origin === "https://graph.facebook.com")).toBe(true);
    expect(ig.calls.some((u) => u.pathname === "/v27.0/me" || u.pathname.startsWith("/v27.0/me/"))).toBe(false);
    expect(ig.calls.filter((u) => u.pathname === `/v27.0/${IG}`)[0].searchParams.get("fields")).toBe("id,username,followers_count");
  });

  it("a rerun adds nothing twice: same posts, one reading per post and day, one follower row", async () => {
    await syncInstagram(store.db, NOW);
    ig.state.views.m1 = 5400;
    ig.state.followers = 1310;
    const again = await syncInstagram(store.db, new Date(NOW.getTime() + 60_000));
    expect(again).toMatchObject({ postsAdded: 0, readings: 3 });
    expect(store.rows("deals")).toHaveLength(1);
    expect(store.rows("posts")).toHaveLength(3);
    expect(store.rows("post_view_snapshots")).toHaveLength(3);
    expect(store.rows("post_view_snapshots").map((s) => s.views)).toContain(5400);
    expect(store.rows("personal_brand_followers")).toEqual([expect.objectContaining({ followers: 1310 })]);
  });

  it("matches a post already on the Personal Brand deal by shortcode, whatever its URL form", async () => {
    store.rows("deals").push({ id: "deal-pb", brand_name: "Personal Brand", personal_brand: true, created_at: "2026-01-01T00:00:00Z" });
    store.rows("posts").push({ id: "imported", deal_id: "deal-pb", platform: "INSTAGRAM", url: "https://instagram.com/studio.notes/p/Code3" });
    const r = await syncInstagram(store.db, NOW);
    expect(r.postsAdded).toBe(2);
    expect(store.rows("deals")).toHaveLength(1);
    expect(store.rows("posts")).toHaveLength(3);
    expect(store.rows("post_view_snapshots").find((s) => s.post_id === "imported")).toMatchObject({ views: 12000 });
  });

  it("a typed count for the day is replaced by Instagram's; other days stay", async () => {
    store.rows("personal_brand_followers").push({ day: "2026-11-21", followers: 999, source: "manual" }, { day: "2026-11-20", followers: 1250, source: "manual" });
    await syncInstagram(store.db, NOW);
    expect(store.rows("personal_brand_followers")).toEqual([
      expect.objectContaining({ day: "2026-11-21", followers: 1300, source: "instagram" }),
      expect.objectContaining({ day: "2026-11-20", followers: 1250, source: "manual" }),
    ]);
  });

  it("two runs at once: the second finds the lease taken and writes nothing", async () => {
    const [a, b] = await Promise.all([run(() => syncInstagram(store.db, NOW)), run(() => syncInstagram(store.db, NOW))]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect((a.ok ? b : a) as { error: { code: string } }).toMatchObject({ error: { code: "busy" } });
    expect(store.rows("deals")).toHaveLength(1);
    expect(store.rows("posts")).toHaveLength(3);
    expect(conn().sync_started_at).toBeNull();
  });

  it("a run that died leaves a lease; after 10 minutes the next run takes it over", async () => {
    conn().sync_started_at = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: false, error: { code: "busy" } });
    conn().sync_started_at = new Date(NOW.getTime() - 11 * 60_000).toISOString();
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: true, data: { readings: 3 } });
  });

  /** Holds the first Instagram call to `path` until `release()`. */
  const holdAt = (path: string) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    let reached!: () => void;
    const arrived = new Promise<void>((r) => (reached = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (!held && new URL(String(input)).pathname === path) {
          held = true;
          reached();
          await gate;
        }
        return ig.fetch(input, init);
      }),
    );
    return { arrived, release };
  };

  it("a reconnect mid-run keeps the lease: no second run beside it, one Personal Brand deal", async () => {
    const hold = holdAt(`/v27.0/${IG}`);
    const a = run(() => syncInstagram(store.db, NOW));
    await hold.arrived;
    await finishSignIn({ code: "good-code", requestUrl: CALLBACK });
    expect(conn().sync_started_at).toBe(NOW.toISOString());
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: false, error: { code: "busy" } });
    hold.release();
    await a;
    expect(store.rows("deals")).toHaveLength(1);
    expect(conn().sync_started_at).toBeNull();
  });

  it("a reel already on a UGC deal under another URL form is not added to Personal Brand", async () => {
    store.rows("deals").push({ id: "deal-ugc", brand_name: "Acme", personal_brand: false, created_at: "2026-01-01T00:00:00Z" });
    store.rows("posts").push({ id: "ugc-post", deal_id: "deal-ugc", platform: "INSTAGRAM", url: "https://instagram.com/p/Code3" });
    const r = await syncInstagram(store.db, NOW);
    expect(r).toMatchObject({ postsAdded: 2, skipped: 1 });
    expect(store.rows("posts").filter((p) => String(p.url).endsWith("/Code3"))).toEqual([expect.objectContaining({ id: "ugc-post", deal_id: "deal-ugc" })]);
    expect(store.rows("post_view_snapshots").some((s) => s.post_id === "ugc-post")).toBe(false);
  });

  it("a throttle mid-run keeps what it wrote, backs off an hour, and the retry finishes without doubles", async () => {
    ig.state.insightsBudget = 2;
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(store.rows("posts")).toHaveLength(3);
    expect(store.rows("post_view_snapshots").length).toBeGreaterThanOrEqual(1);
    expect(conn()).toMatchObject({ last_error: "rate_limited", sync_started_at: null, last_synced_at: null });

    const before = ig.calls.length;
    expect(await run(() => syncInstagram(store.db, new Date(NOW.getTime() + 30 * 60_000)))).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(ig.calls.length).toBe(before);

    ig.state.insightsBudget = null;
    const later = new Date(NOW.getTime() + 61 * 60_000);
    vi.setSystemTime(later);
    expect(await run(() => syncInstagram(store.db, later))).toMatchObject({ ok: true, data: { postsAdded: 0, readings: 3 } });
    expect(store.rows("posts")).toHaveLength(3);
    expect(store.rows("post_view_snapshots")).toHaveLength(3);
    expect(conn()).toMatchObject({ last_error: null });
  });

  it("a revoked token sets reauth_required, keeps every saved row, and the next run asks Instagram nothing", async () => {
    await syncInstagram(store.db, NOW);
    ig.state.revoked = true;
    expect(await run(() => syncInstagram(store.db, new Date(NOW.getTime() + DAY)))).toMatchObject({ ok: false, error: { code: "reauth_required" } });
    expect(conn().last_error).toBe("reauth_required");
    expect(store.rows("posts")).toHaveLength(3);
    expect(store.rows("post_view_snapshots")).toHaveLength(3);
    const before = ig.calls.length;
    expect(await run(() => syncInstagram(store.db, new Date(NOW.getTime() + 2 * DAY)))).toMatchObject({ ok: false, error: { code: "reauth_required" } });
    expect(ig.calls.length).toBe(before);
  });

  it("never filters the connection row on the sealed token (a filter rides in the request URL)", async () => {
    const filters: string[] = [];
    const spy = {
      from(table: string) {
        const b = store.db.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
        for (const op of ["eq", "is", "lt", "in"]) {
          const real = b[op];
          b[op] = (column: unknown, value: unknown) => (filters.push(`${table}.${String(column)}`), real(column, value));
        }
        return b;
      },
    } as unknown as typeof store.db;
    await syncInstagram(spy, NOW);
    ig.state.revoked = true;
    await run(() => syncInstagram(spy, new Date(NOW.getTime() + DAY))); // the error write
    expect(filters).toContain("instagram_connections.token_id");
    expect(filters.filter((f) => f.endsWith(".access_token"))).toEqual([]);
    expect(conn().last_error).toBe("reauth_required");
  });

  it("a token sealed under another HYDRA_TOKEN_KEY stores reauth_required, so the page shows Reconnect", async () => {
    vi.stubEnv("HYDRA_TOKEN_KEY", Buffer.alloc(32, 9).toString("base64"));
    conn().access_token = encryptToken("bisu-1", CONN);
    vi.stubEnv("HYDRA_TOKEN_KEY", Buffer.alloc(32, 7).toString("base64"));
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: false, error: { code: "reauth_required" } });
    expect(conn()).toMatchObject({ last_error: "reauth_required", last_synced_at: null, sync_started_at: null });
    expect(instagramState({ missing: [], username: "studio.notes", lastSyncedAt: null, lastError: conn().last_error as string })).toBe("reconnect");
    expect(ig.calls).toEqual([]);
  });

  it("every insights read refused is still a sync: each post is skipped, the run is insights_partial, the next day syncs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ig.state.insightsError = { code: 100, message: "Unsupported request" };
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: true, data: { readings: 0, insightsFailed: 3 } });
    expect(conn()).toMatchObject({ last_error: "insights_partial", last_synced_at: NOW.toISOString(), sync_started_at: null });
    expect(instagramNeedsGrant({ missing: [], username: "studio.notes", lastSyncedAt: null, lastError: "insights_partial" })).toBe(false);
    // The posts and the follower count synced; no reading was made up.
    expect(store.rows("posts")).toHaveLength(3);
    expect(store.rows("personal_brand_followers")).toHaveLength(1);
    expect(store.rows("post_view_snapshots")).toEqual([]);
    ig.state.insightsError = null;
    expect(await run(() => syncInstagram(store.db, new Date(NOW.getTime() + DAY)))).toMatchObject({ ok: true, data: { readings: 3 } });
    expect(conn().last_error).toBeNull();
    vi.mocked(console.error).mockRestore();
  });

  it("one or two low-reach posts refused with #10 are a partial sync, never a Reconnect offer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ig.state.media = [media(1, 1)];
    ig.state.insightsError = { code: 10, message: "(#10) Not enough viewers for the media to show insights" };
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: true, data: { readings: 0, insightsFailed: 1, insightsRefused: false } });
    expect(conn().last_error).toBe("insights_partial");
    expect(instagramNeedsGrant({ missing: [], username: "studio.notes", lastSyncedAt: NOW.toISOString(), lastError: conn().last_error as string })).toBe(false);
    vi.mocked(console.error).mockRestore();
  });

  it("every post refused with #10 (low-reach posts, or a grant taken back) never signs out; Settings offers Reconnect, day after day", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ig.state.insightsError = { code: 10, message: "(#10) Not enough viewers for the media to show insights" };
    for (const day of [0, 1]) {
      const at = new Date(NOW.getTime() + day * DAY);
      ig.state.followers = 1300 + day;
      expect(await run(() => syncInstagram(store.db, at))).toMatchObject({ ok: true, data: { readings: 0, insightsFailed: 3, insightsRefused: true } });
      expect(conn()).toMatchObject({ last_error: "insights_refused", last_synced_at: at.toISOString() });
    }
    // Followers kept syncing: the second day's count is stored.
    expect(store.rows("personal_brand_followers").map((f) => f.followers)).toContain(1301);
    const view = { missing: [], username: "studio.notes", lastSyncedAt: NOW.toISOString(), lastError: conn().last_error as string };
    expect(instagramState(view)).toBe("connected");
    expect(instagramNeedsGrant(view)).toBe(true);
    expect(instagramErrorNote(view.lastError)).toBe("Instagram refused views for every post. If this lasts, Reconnect in Settings.");
    // A 200-range refusal on a post is the same.
    ig.state.insightsError = { code: 200, message: "Permissions error" };
    expect(await run(() => syncInstagram(store.db, new Date(NOW.getTime() + 2 * DAY)))).toMatchObject({ ok: true });
    expect(conn().last_error).toBe("insights_refused");
    // Views back: the note clears.
    ig.state.insightsError = null;
    expect(await run(() => syncInstagram(store.db, new Date(NOW.getTime() + 3 * DAY)))).toMatchObject({ ok: true, data: { readings: 3, insightsRefused: false } });
    expect(conn().last_error).toBeNull();
    vi.mocked(console.error).mockRestore();
  });

  it("the profile read refused for a permission (#10) asks for a reconnect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
        new URL(String(input)).pathname === `/v27.0/${IG}` ? new Response(JSON.stringify({ error: { code: 10, message: "Application does not have permission" } }), { status: 400 }) : ig.fetch(input, init),
      ),
    );
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: false, error: { code: "reauth_required" } });
    expect(conn().last_error).toBe("reauth_required");
  });

  it("one refused insights read among good ones is still a sync", async () => {
    ig.state.views = { m1: 5000, m3: 12000 };
    const real = ig.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
        new URL(String(input)).pathname === "/v27.0/m2/insights" ? new Response(JSON.stringify({ error: { code: 100 } }), { status: 400 }) : real(input, init),
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: true, data: { readings: 2, skipped: 0, insightsFailed: 1 } });
    // Synced, and the page says some views were refused.
    expect(conn()).toMatchObject({ last_error: "insights_partial", last_synced_at: NOW.toISOString() });
    expect(instagramState({ missing: [], username: "studio.notes", lastSyncedAt: NOW.toISOString(), lastError: "insights_partial" })).toBe("connected");
    vi.mocked(console.error).mockRestore();
  });

  /** Only `path` answers 400 with `error`; the rest of Instagram answers normally. */
  const refuseAt = (path: string, error: Record<string, unknown>) => {
    const real = ig.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => (new URL(String(input)).pathname === path ? new Response(JSON.stringify({ error }), { status: 400 }) : real(input, init))),
    );
  };

  it("one post's #10 (too few viewers) is that post's failure: no Reconnect, and the next day syncs again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    refuseAt("/v27.0/m2/insights", { code: 10, message: "(#10) Not enough viewers for the media to show insights" });
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: true, data: { readings: 2, insightsFailed: 1 } });
    expect(conn()).toMatchObject({ last_error: "insights_partial", last_synced_at: NOW.toISOString() });
    const before = ig.calls.length;
    const next = new Date(NOW.getTime() + DAY);
    expect(await run(() => syncInstagram(store.db, next))).toMatchObject({ ok: true, data: { readings: 2, insightsFailed: 1 } });
    expect(ig.calls.length).toBeGreaterThan(before);
    expect(conn()).toMatchObject({ last_error: "insights_partial", last_synced_at: next.toISOString() });
    vi.mocked(console.error).mockRestore();
  });

  it("a 190 on one post's insights is still a dead token: the run stops and asks for a reconnect", async () => {
    refuseAt("/v27.0/m2/insights", { code: 190, type: "OAuthException" });
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: false, error: { code: "reauth_required" } });
    expect(conn().last_error).toBe("reauth_required");
  });

  it("one post with no views and one refused is not Synced over nothing: the refusal is reported", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ig.state.media = [media(1, 1), media(2, 3)];
    ig.state.views = {}; // m1: Instagram has no views yet
    refuseAt("/v27.0/m2/insights", { code: 100 });
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: true, data: { readings: 0, skipped: 1, insightsFailed: 1 } });
    expect(conn().last_error).toBe("insights_partial");
    vi.mocked(console.error).mockRestore();
  });

  it("a clean sync clears a soft last_error", async () => {
    conn().last_error = "insights_partial";
    await syncInstagram(store.db, NOW);
    expect(conn().last_error).toBeNull();
  });

  it("a sign-in that did not grant insights syncs profile and posts, reads no insights, and notes it quietly (no Reconnect loop)", async () => {
    conn().scopes = "instagram_basic";
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: true, data: { postsAdded: 3, readings: 0, insightsGranted: false } });
    expect(ig.calls.some((u) => u.pathname.endsWith("/insights"))).toBe(false);
    expect(conn()).toMatchObject({ last_error: "insights_not_granted", last_synced_at: NOW.toISOString() });
    expect(store.rows("posts")).toHaveLength(3);
    expect(store.rows("personal_brand_followers")).toHaveLength(1);
    const view = { missing: [], username: "studio.notes", lastSyncedAt: NOW.toISOString(), lastError: conn().last_error as string };
    expect(instagramState(view)).toBe("connected");
    expect(instagramNeedsGrant(view)).toBe(true);
    // The next day still syncs.
    const next = new Date(NOW.getTime() + DAY);
    expect(await run(() => syncInstagram(store.db, next))).toMatchObject({ ok: true });
    expect(conn().last_synced_at).toBe(next.toISOString());
    // A reconnect that grants insights clears the note on its next sync.
    // Unified Login reports no grant list: a reconnect stores none, and insights are read again.
    await finishSignIn({ code: "good-code", requestUrl: CALLBACK });
    expect(await run(() => syncInstagram(store.db, new Date(NOW.getTime() + 2 * DAY)))).toMatchObject({ ok: true, data: { readings: 3, insightsGranted: true } });
    expect(conn().last_error).toBeNull();
  });

  it("a token that never expires or has days left syncs with no refresh; one past its expiry asks for a reconnect without calling Instagram", async () => {
    await syncInstagram(store.db, NOW);
    conn().expires_at = new Date(NOW.getTime() + 3 * DAY).toISOString();
    expect(await run(() => syncInstagram(store.db, new Date(NOW.getTime() + 60_000)))).toMatchObject({ ok: true });
    expect(ig.calls.some((u) => u.pathname.includes("access_token"))).toBe(false);
    conn().expires_at = new Date(NOW.getTime() - 1000).toISOString();
    const before = ig.calls.length;
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: false, error: { code: "reauth_required" } });
    expect(ig.calls.length).toBe(before);
  });

  it("not connected: a typed error, no call", async () => {
    store.tables.instagram_connections = [];
    await expect(syncInstagram(store.db, NOW)).rejects.toBeInstanceOf(InstagramError);
    expect(ig.calls).toEqual([]);
  });

  it("follows the media pages and stops at the 120-day edge, asking Instagram for that window", async () => {
    ig.state.media = Array.from({ length: 130 }, (_, i) => media(100 + i, i)); // one a day
    const r = await syncInstagram(store.db, NOW);
    expect(r).toMatchObject({ media: 121, cut: false }); // days 0 to 120
    const pages = ig.calls.filter((u) => u.pathname === `/v27.0/${IG}/media`);
    expect(pages).toHaveLength(3);
    const since = String(Math.floor((NOW.getTime() - 120 * DAY) / 1000));
    expect(pages.every((u) => u.searchParams.get("since") === since)).toBe(true);
  });

  it("the page cap reports the media it left unread", async () => {
    ig.state.media = Array.from({ length: 600 }, (_, i) => media(1000 + i, i / 10)); // ten a day
    ig.state.views = {};
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await syncInstagram(store.db, NOW);
    expect(r).toMatchObject({ media: 500, cut: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("page cap"));
    // Stored, so the page says posts were left out.
    expect(conn()).toMatchObject({ last_error: "media_cut", last_synced_at: NOW.toISOString() });
    warn.mockRestore();
  });

  /** 600 window media (ten a day): the page cap stops at 500, and the look-ahead page (after=500) answers `error`. */
  const lookAheadAnswers = (status: number, error: Record<string, unknown>) => {
    ig.state.media = Array.from({ length: 600 }, (_, i) => media(1000 + i, i / 10));
    ig.state.views = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        return url.pathname === `/v27.0/${IG}/media` && url.searchParams.get("after") === "500" ? new Response(JSON.stringify({ error }), { status }) : ig.fetch(input, init);
      }),
    );
  };

  it("a throttle on the look-ahead page stops the run as rate_limited, before any insights call", async () => {
    lookAheadAnswers(403, { code: 80002, message: "throttled" });
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(conn().last_error).toBe("rate_limited");
    expect(ig.calls.some((u) => u.pathname.endsWith("/insights"))).toBe(false);
  });

  it("a dead token on the look-ahead page is reauth_required, not a cut", async () => {
    lookAheadAnswers(400, { code: 190, type: "OAuthException" });
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: false, error: { code: "reauth_required" } });
    expect(conn().last_error).toBe("reauth_required");
  });

  it("a plain refusal of the look-ahead page counts as a cut", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    lookAheadAnswers(400, { code: 100 });
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: true, data: { media: 500, cut: true } });
    expect(conn().last_error).toBe("media_cut");
    warn.mockRestore();
  });

  it("no answer on the look-ahead page counts as a cut, the likely case at the cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ig.state.media = Array.from({ length: 600 }, (_, i) => media(1000 + i, i / 10));
    ig.state.views = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === `/v27.0/${IG}/media` && url.searchParams.get("after") === "500") throw new DOMException("timed out", "TimeoutError");
        return ig.fetch(input, init);
      }),
    );
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: true, data: { media: 500, cut: true } });
    expect(conn().last_error).toBe("media_cut");
    warn.mockRestore();
  });

  it("a refused post and a page cut in one run: both are stored, and the hover names both", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    ig.state.media = Array.from({ length: 600 }, (_, i) => media(1000 + i, i / 10));
    ig.state.views = {};
    refuseAt("/v27.0/m1001/insights", { code: 100 });
    expect(await run(() => syncInstagram(store.db, NOW))).toMatchObject({ ok: true, data: { cut: true, insightsFailed: 1 } });
    expect(conn().last_error).toBe("insights_partial,media_cut");
    expect(instagramErrorNote(conn().last_error as string)).toBe("Instagram refused views for some posts. The last sync stopped at 500 posts; older ones were left out.");
    expect(instagramState({ missing: [], username: "studio.notes", lastSyncedAt: NOW.toISOString(), lastError: conn().last_error as string })).toBe("connected");
    vi.mocked(console.warn).mockRestore();
    vi.mocked(console.error).mockRestore();
  });

  it("the cap landing on the window's last page is not a cut: the page after it holds only older media", async () => {
    // 50 a page: two pages fill the window, the third holds only media older than 120 days.
    ig.state.media = [...Array.from({ length: 100 }, (_, i) => media(2000 + i, i)), ...Array.from({ length: 30 }, (_, i) => media(3000 + i, 130 + i))];
    ig.state.views = {};
    const { media: got, cut } = await recentMedia("bisu-1", IG, new Date(NOW.getTime() - 120 * DAY), 2);
    expect(got).toHaveLength(100);
    expect(cut).toBe(false);
    expect(ig.calls.filter((u) => u.pathname === `/v27.0/${IG}/media`)).toHaveLength(3);
    // With window media past the cap, it is.
    expect((await recentMedia("bisu-1", IG, new Date(NOW.getTime() - 120 * DAY), 1)).cut).toBe(true);
  });

  it("one old item (a pinned post) on a page does not end the paging", async () => {
    const row = (id: string, days: number) => ({ id, shortcode: `C${id}`, permalink: `https://www.instagram.com/p/C${id}/`, timestamp: new Date(NOW.getTime() - days * DAY).toISOString() });
    const pages: Record<string, unknown> = {
      "": { data: [row("a", 1), row("pinned", 300)], paging: { cursors: { after: "p2" } } },
      p2: { data: [row("b", 2), row("c", 3)], paging: { cursors: { after: "p3" } } },
      p3: { data: [row("old", 200)], paging: { cursors: { after: "p4" } } },
    };
    const calls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        calls.push(url);
        return new Response(JSON.stringify(pages[url.searchParams.get("after") ?? ""]), { status: 200 });
      }),
    );
    const { media: got, cut } = await recentMedia("t", IG, new Date(NOW.getTime() - 120 * DAY));
    expect(got.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(cut).toBe(false);
    expect(calls).toHaveLength(3); // the page with nothing in the window ends it
  });

  it("follows paging.next on graph.facebook.com; a next link on another host is never followed (the after cursor is)", async () => {
    const row = (id: string, days: number) => ({ id, shortcode: `C${id}`, permalink: `https://www.instagram.com/p/C${id}/`, timestamp: new Date(NOW.getTime() - days * DAY).toISOString() });
    const calls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        calls.push(url);
        const page = url.searchParams.get("page") ?? url.searchParams.get("after") ?? "";
        const body: Record<string, unknown> = {
          "": { data: [row("a", 1)], paging: { cursors: { after: "c2" }, next: `https://graph.facebook.com/v27.0/${IG}/media?page=p2&access_token=t` } },
          p2: { data: [row("b", 2)], paging: { cursors: { after: "c3" }, next: "https://evil.example/steal?page=p3" } },
          c3: { data: [row("c", 3)], paging: {} },
        };
        return new Response(JSON.stringify(body[page]), { status: 200 });
      }),
    );
    const { media: got } = await recentMedia("t", IG, new Date(NOW.getTime() - 120 * DAY));
    expect(got.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(calls.map((u) => u.host)).toEqual(["graph.facebook.com", "graph.facebook.com", "graph.facebook.com"]);
    expect(calls[2].pathname).toBe(`/v27.0/${IG}/media`);
    expect(calls[2].searchParams.get("after")).toBe("c3");
  });
});
