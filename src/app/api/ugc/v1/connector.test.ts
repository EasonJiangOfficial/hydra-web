// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryKey } from "./memory-db";

const mocks = vi.hoisted(() => ({ createAdminClient: vi.fn(), createServerClient: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/supabase/server", () => ({ createServerClient: mocks.createServerClient }));

const { generateApiKey } = await import("@/lib/keys/keys");
const contextRoute = await import("./context/route");
const postsRoute = await import("./posts/route");
const viewsRoute = await import("./views/route");
const mcpRoute = await import("../../mcp/ugc/route");

const DEAL = "d0000000-0000-4000-8000-000000000001";
const OTHER_DEAL = "d0000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-11-21T15:00:00.000Z");
const BASE = "https://hydra.example";

let mem: ReturnType<typeof memoryDb>;
let key: MemoryKey;
let secret: string;

function addKey(over: Partial<MemoryKey> = {}) {
  const k = generateApiKey();
  const row: MemoryKey = {
    id: crypto.randomUUID(),
    key_hash: k.hash,
    scope: "ugc:write",
    revoked_at: null,
    rate_limit_per_minute: 120,
    window: null,
    count: 0,
    last_used_at: null,
    ...over,
  };
  mem.keys.push(row);
  return { row, secret: k.secret };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mem = memoryDb({
    deals: [
      { id: DEAL, brand_name: "Acme", status: "active", start_date: "2026-11-01", end_date: null, daily_target_posts: 2, view_freeze_days: null },
      { id: OTHER_DEAL, brand_name: "Bolt", status: "ended", start_date: "2026-10-01", end_date: "2026-10-31", daily_target_posts: 1, view_freeze_days: 7 },
    ],
    deal_accounts: [{ id: "a0000000-0000-4000-8000-000000000001", deal_id: DEAL, platform: "TIKTOK", handle: "me" }],
  });
  mocks.createAdminClient.mockReturnValue(mem.db);
  ({ row: key, secret } = addKey());
});
afterEach(() => vi.useRealTimers());

// ─── Transports ──────────────────────────────────────────────────────────────

const auth = (s: string | null = secret): Record<string, string> => (s === null ? {} : { authorization: `Bearer ${s}` });

const rest = {
  context: (s?: string | null) => contextRoute.GET(new Request(`${BASE}/api/ugc/v1/context`, { headers: auth(s) })),
  needing: (s?: string | null) => postsRoute.GET(new Request(`${BASE}/api/ugc/v1/posts?needsViews=1`, { headers: auth(s) })),
  addPost: (body: unknown, s?: string | null) =>
    postsRoute.POST(new Request(`${BASE}/api/ugc/v1/posts`, { method: "POST", headers: { ...auth(s), "content-type": "application/json" }, body: JSON.stringify(body) })),
  setViews: (body: unknown, s?: string | null) =>
    viewsRoute.POST(new Request(`${BASE}/api/ugc/v1/views`, { method: "POST", headers: { ...auth(s), "content-type": "application/json" }, body: JSON.stringify(body) })),
};

let rpcId = 0;
function mcpPost(method: string, params: unknown, s: string | null = secret) {
  return mcpRoute.POST(
    new Request(`${BASE}/api/mcp/ugc`, {
      method: "POST",
      headers: { ...auth(s), "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    }),
  );
}

type Envelope = { ok: boolean; data?: Record<string, unknown> & { items?: Record<string, unknown>[] }; error?: { code: string } };

/**
 * tools/call over MCP: the tool's ActionResult and the MCP isError flag. The SDK checks the
 * input against the same zod schema first and answers a bad one itself (isError, -32602).
 */
async function mcpCall(name: string, args: unknown = {}): Promise<Envelope & { isError: boolean }> {
  const res = await mcpPost("tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  const text = body.result.content[0].text;
  const isError = body.result.isError === true;
  if (text.startsWith("MCP error -32602: Input validation error")) {
    expect(isError).toBe(true);
    return { ok: false, error: { code: "invalid_input" }, isError };
  }
  return { ...(JSON.parse(text) as Envelope), isError };
}

/** The same tool over both transports, so every behaviour below is proven on REST and MCP. */
const both = {
  REST: {
    context: async () => (await rest.context()).json() as Promise<Envelope>,
    needing: async () => (await rest.needing()).json() as Promise<Envelope>,
    addPost: async (b: unknown) => (await rest.addPost(b)).json() as Promise<Envelope>,
    setViews: async (b: unknown) => (await rest.setViews(b)).json() as Promise<Envelope>,
  },
  MCP: {
    context: () => mcpCall("ugc_context"),
    needing: () => mcpCall("ugc_posts_needing_views"),
    addPost: (b: unknown) => mcpCall("ugc_add_post", b),
    setViews: (b: unknown) => mcpCall("ugc_set_views", b),
  },
};

const post = (over: Record<string, unknown> = {}) => ({
  url: "https://www.tiktok.com/@me/video/7300000000000000001?is_from_webapp=1",
  platform: "TIKTOK",
  account: "@Me",
  dealId: DEAL,
  postedAt: "2026-11-18T10:00:00Z",
  videoGroupId: "vid-1",
  ...over,
});

// ─── Auth ────────────────────────────────────────────────────────────────────

describe("key check (REST and MCP)", () => {
  const calls = {
    "GET /context": (s: string | null) => rest.context(s),
    "GET /posts?needsViews=1": (s: string | null) => rest.needing(s),
    "POST /posts": (s: string | null) => rest.addPost(post(), s),
    "POST /views": (s: string | null) => rest.setViews({ capturedAt: NOW.toISOString(), items: [{ url: post().url, views: 1 }] }, s),
    "POST /api/mcp/ugc": (s: string | null) => mcpPost("tools/list", {}, s),
  };

  it.each(Object.entries(calls))("%s: no key or a malformed key is 401 before any database call", async (_name, call) => {
    for (const s of [null, "not-a-key", `hyd_ugc_${"x".repeat(39)}`, `hyd_fin_${"x".repeat(40)}`]) {
      const res = await call(s);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    }
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect([...mem.touched]).toEqual([]);
  });

  it.each(Object.entries(calls))("%s: an unknown key and a revoked key are 401 and touch no UGC table", async (_name, call) => {
    expect((await call(generateApiKey().secret)).status).toBe(401);
    key.revoked_at = "2026-11-21T14:00:00.000Z";
    expect((await call(secret)).status).toBe(401);
    expect([...mem.touched]).toEqual(["rpc:api_key_authenticate"]);
  });

  it.each(Object.entries(calls))("%s: a key without ugc:write is 403", async (_name, call) => {
    const other = addKey({ scope: "other:read" });
    expect((await call(other.secret)).status).toBe(403);
  });

  it("rate limits per key across REST and MCP, with Retry-After, and leaves other keys alone", async () => {
    key.rate_limit_per_minute = 3;
    expect((await rest.context()).status).toBe(200);
    expect((await mcpPost("tools/list", {})).status).toBe(200);
    expect((await rest.needing()).status).toBe(200);
    const limited = await rest.context();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("42");
    expect((await mcpPost("tools/list", {})).status).toBe(429);
    const second = addKey();
    expect((await rest.context(second.secret)).status).toBe(200);
  });

  it("stamps last used on a good call", async () => {
    expect(key.last_used_at).toBeNull();
    await rest.context();
    expect(key.last_used_at).toBe(NOW.toISOString());
  });
});

// ─── The four tools, on both transports ──────────────────────────────────────

describe.each(Object.entries(both))("tools over %s", (_transport, t) => {
  it("ugc_context: deals with accounts, server time, the owner's day and missed days", async () => {
    mem.tables.settings[0].time_zone = "America/New_York";
    mem.setMissedDays([{ day: "2026-11-19", posts_needing: 3, posts_read: 1 }]);
    const res = await t.context();
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({
      serverTime: NOW.toISOString(),
      timeZone: "America/New_York",
      today: "2026-11-21",
      deals: [
        {
          id: DEAL,
          brandName: "Acme",
          status: "active",
          startDate: "2026-11-01",
          endDate: null,
          dailyTargetPosts: 2,
          viewFreezeDays: null,
          accounts: [{ id: "a0000000-0000-4000-8000-000000000001", platform: "TIKTOK", handle: "me" }],
        },
        expect.objectContaining({ id: OTHER_DEAL, status: "ended", accounts: [] }),
      ],
      missedDays: [{ day: "2026-11-19", postsNeeding: 3, postsRead: 1 }],
    });
  });

  it("ugc_add_post: upserts on the normalized URL, as grokbot, on the deal's account", async () => {
    const first = await t.addPost(post());
    expect(first).toMatchObject({
      ok: true,
      data: { created: true, dealId: DEAL, url: "https://tiktok.com/@me/video/7300000000000000001", platform: "TIKTOK", videoGroupId: "vid-1" },
    });
    const again = await t.addPost(post({ url: "http://m.tiktok.com/@me/video/7300000000000000001/?utm_source=x#top" }));
    expect(again).toMatchObject({ ok: true, data: { created: false, postId: first.data!.postId } });
    expect(mem.tables.posts).toHaveLength(1);
    expect(mem.tables.posts[0]).toMatchObject({ source: "grokbot", account_id: "a0000000-0000-4000-8000-000000000001", exclude_from_pay: false });
  });

  it("ugc_add_post: refuses bad input, an unknown deal and a URL on another deal", async () => {
    expect(await t.addPost(post({ account: undefined }))).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await t.addPost(post({ url: "ftp://tiktok.com/x" }))).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await t.addPost(post({ dealId: "d0000000-0000-4000-8000-00000000ffff" }))).toMatchObject({ ok: false, error: { code: "not_found" } });
    await t.addPost(post());
    expect(await t.addPost(post({ dealId: OTHER_DEAL }))).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("ugc_add_post: an exclude or pay field in the body is ignored, never applied", async () => {
    const res = await t.addPost(post({ excludeFromPay: true, exclude_from_pay: true, manualOverrideCents: 99999, source: "hydra" }));
    expect(res.ok).toBe(true);
    expect(mem.tables.posts[0]).toMatchObject({ exclude_from_pay: false, manual_override_cents: null, source: "grokbot" });
  });

  it("ugc_posts_needing_views: today's list, then empty once read", async () => {
    const added = await t.addPost(post());
    const before = await t.needing();
    expect(before).toMatchObject({
      ok: true,
      data: {
        today: "2026-11-21",
        posts: [{ postId: added.data!.postId, dealId: DEAL, account: "me", lastViews: null, lastCapturedAt: null, postedAt: "2026-11-18T10:00:00Z" }],
      },
    });
    await t.setViews({ capturedAt: "2026-11-21T14:00:00.000Z", items: [{ postId: added.data!.postId, views: 1200 }] });
    expect(await t.needing()).toMatchObject({ ok: true, data: { posts: [] } });
  });

  it("ugc_set_views guards: lower rejected (no force from a key), 10x jump held, one reading per day", async () => {
    const id = (await t.addPost(post())).data!.postId as string;
    const set = (views: number, capturedAt: string, extra: Record<string, unknown> = {}) =>
      t.setViews({ capturedAt, ...extra, items: [{ postId: id, views }] });

    expect((await set(5000, "2026-11-20T12:00:00.000Z")).data!.items![0]).toMatchObject({ status: "written" });
    expect((await set(4000, "2026-11-21T12:00:00.000Z")).data!.items![0]).toMatchObject({ status: "rejected_lower", previous: 5000 });
    expect((await set(4000, "2026-11-21T12:00:00.000Z", { force: true })).data!.items![0]).toMatchObject({ status: "rejected_lower", previous: 5000 });

    expect((await set(60000, "2026-11-21T12:30:00.000Z")).data!.items![0]).toMatchObject({ status: "held", previous: 5000 });
    const today = () => mem.tables.post_view_snapshots.filter((s) => s.post_id === id && s.captured_day === "2026-11-21");
    expect(today()).toEqual([expect.objectContaining({ views: 60000, held: true, source: "grokbot" })]);

    expect((await set(6000, "2026-11-21T13:00:00.000Z")).data!.items![0]).toMatchObject({ status: "written" });
    expect(today()).toEqual([expect.objectContaining({ views: 6000, held: false })]);
    expect(mem.tables.post_view_snapshots).toHaveLength(2);
  });

  it("ugc_set_views: by URL, unknown posts, frozen posts and bad input, item by item", async () => {
    const id = (await t.addPost(post())).data!.postId as string;
    mem.tables.posts.push({
      id: "e0000000-0000-4000-8000-000000000009",
      deal_id: OTHER_DEAL,
      url: "https://tiktok.com/@me/video/old",
      platform: "TIKTOK",
      posted_at: "2026-10-01T10:00:00.000Z",
      exclude_from_pay: false,
    });
    const res = await t.setViews({
      capturedAt: "2026-11-21T14:00:00.000Z",
      items: [
        { url: "https://www.tiktok.com/@me/video/7300000000000000001?x=1", views: 10, likes: 2, comments: 1 },
        { postId: "e0000000-0000-4000-8000-00000000dead", views: 10 },
        { postId: "e0000000-0000-4000-8000-000000000009", views: 10 },
      ],
    });
    expect(res.data!.items!.map((i) => i.status)).toEqual(["written", "not_found", "rejected_frozen"]);
    expect(mem.tables.post_view_snapshots).toEqual([expect.objectContaining({ post_id: id, views: 10, likes: 2, comments: 1 })]);
    expect(await t.setViews({ capturedAt: "yesterday", items: [{ postId: id, views: 1 }] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await t.setViews({ capturedAt: NOW.toISOString(), items: [{ postId: id, url: post().url, views: 1 }] })).toMatchObject({ ok: false });
    expect(await t.setViews({ capturedAt: NOW.toISOString(), items: [] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("REST and MCP details", () => {
  it("REST maps results to HTTP statuses and rejects a broken body", async () => {
    expect((await rest.addPost(post())).status).toBe(200);
    expect((await rest.addPost(post({ dealId: "d0000000-0000-4000-8000-00000000ffff", url: "https://tiktok.com/@me/video/2" }))).status).toBe(404);
    expect((await rest.addPost(post({ dealId: OTHER_DEAL }))).status).toBe(409);
    expect((await rest.addPost({})).status).toBe(400);
    const broken = new Request(`${BASE}/api/ugc/v1/views`, { method: "POST", headers: auth(), body: "{" });
    expect((await viewsRoute.POST(broken)).status).toBe(400);
  });

  it("MCP initializes and lists exactly the four tools, with no exclude or force input", async () => {
    const init = await mcpPost("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grokbot", version: "1" } });
    expect(init.status).toBe(200);
    expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("hydra-ugc");

    const list = (await (await mcpPost("tools/list", {})).json()) as { result: { tools: { name: string; inputSchema: unknown }[] } };
    expect(list.result.tools.map((x) => x.name).sort()).toEqual(["ugc_add_post", "ugc_context", "ugc_posts_needing_views", "ugc_set_views"]);
    expect(JSON.stringify(list.result.tools)).not.toMatch(/exclude|force|override/i);
  });

  it("MCP reports a tool failure as isError, and an unknown tool as an error", async () => {
    const bad = await mcpCall("ugc_add_post", { url: "nope" });
    expect(bad.isError).toBe(true);
    const unknown = (await (await mcpPost("tools/call", { name: "exclude_post", arguments: { id: DEAL } })).json()) as Record<string, unknown>;
    expect(JSON.stringify(unknown)).toMatch(/not found|error/i);
    expect(mem.tables.posts).toEqual([]);
  });
});

// ─── Scope isolation ─────────────────────────────────────────────────────────

describe("a ugc key reaches UGC data only", () => {
  const UGC_TABLES = ["deals", "deal_accounts", "posts", "post_view_snapshots", "settings"];
  const UGC_RPCS = ["api_key_authenticate", "ugc_last_trusted_views", "ugc_posts_needing_views", "ugc_missed_view_days"].map((r) => `rpc:${r}`);

  it("every tool on both transports touches only UGC tables and the connector RPCs", async () => {
    for (const t of Object.values(both)) {
      const id = ((await t.addPost(post())).data!.postId as string) ?? "";
      await t.context();
      await t.needing();
      await t.setViews({ capturedAt: NOW.toISOString(), items: [{ postId: id, views: 5 }] });
    }
    await mcpPost("tools/list", {});
    expect([...mem.touched].sort()).toEqual([...UGC_TABLES, ...UGC_RPCS].sort());
  });

  it("only the connector routes accept a key: no other route imports the key check", () => {
    const api = join(process.cwd(), "src/app/api");
    const routes = (readdirSync(api, { recursive: true }) as string[]).filter((f) => /(^|\/)route\.ts$/.test(f));
    expect(routes.length).toBeGreaterThan(4);
    const users = routes.filter((f) => /@\/lib\/keys|ugc\/v1\/tools|from "\.\.\/tools"/.test(readFileSync(join(api, f), "utf8")));
    expect(users.sort()).toEqual(["mcp/ugc/route.ts", "ugc/v1/context/route.ts", "ugc/v1/posts/route.ts", "ugc/v1/views/route.ts"]);
  });

  /** What a request with only a bearer key gets from @supabase/ssr: no session, so not the owner. */
  function noSession() {
    const reads: string[] = [];
    const client = {
      rpc: async (name: string) => (name === "is_owner" ? { data: false, error: null } : { data: null, error: { message: "denied", code: "42501" } }),
      auth: { getClaims: async () => ({ data: null, error: null }), getUser: async () => ({ data: { user: null }, error: null }) },
      from: (table: string) => {
        reads.push(table);
        return mem.db.from(table);
      },
    };
    mocks.createServerClient.mockResolvedValue(client);
    return reads;
  }

  it("the finance routes refuse a request that carries a valid ugc key", async () => {
    const reads = noSession();
    vi.stubEnv("PLAID_CLIENT_ID", "");
    vi.stubEnv("PLAID_SECRET", "");
    const linkToken = await import("../../plaid/link-token/route");
    const exchange = await import("../../plaid/exchange/route");
    const webhook = await import("../../plaid/webhook/route");
    const req = (path: string, body: unknown) =>
      new Request(`${BASE}${path}`, { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify(body) });

    expect((await linkToken.POST(req("/api/plaid/link-token", {}))).status).toBe(403);
    expect((await linkToken.POST(req("/api/plaid/link-token", { itemId: "b0000000-0000-4000-8000-000000000001" }))).status).toBe(403);
    expect((await exchange.POST(req("/api/plaid/exchange", { publicToken: "public-sandbox-x" }))).status).toBe(403);
    expect([401, 503]).toContain((await webhook.POST(req("/api/plaid/webhook", { webhook_type: "TRANSACTIONS" }))).status);
    expect(reads).toEqual([]);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("the finance pages and APIs send a request with only a ugc key to /login", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubEnv("HYDRA_OWNER_EMAIL", "owner@example.test");
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("@/proxy");
    for (const path of ["/", "/transactions", "/accounts", "/reports", "/taxes", "/api/plaid/link-token", "/api/plaid/exchange"]) {
      const res = await proxy(new NextRequest(`${BASE}${path}`, { headers: auth() }));
      expect(res.status, path).toBe(307);
      expect(res.headers.get("location"), path).toMatch(/\/login\?next=/);
    }
    vi.unstubAllEnvs();
  });

  it("the exclude action refuses a request that carries a valid ugc key", async () => {
    const reads = noSession();
    expect((await rest.addPost(post())).status).toBe(200);
    const id = mem.tables.posts[0].id as string;
    const { excludePost, unexcludePost } = await import("@/lib/ugc/actions");
    expect(await excludePost({ id })).toMatchObject({ ok: false, error: { code: "not_owner" } });
    expect(await unexcludePost({ id })).toMatchObject({ ok: false, error: { code: "not_owner" } });
    expect(reads).toEqual([]);
    expect(mem.tables.posts[0].exclude_from_pay).toBe(false);
  });
});
