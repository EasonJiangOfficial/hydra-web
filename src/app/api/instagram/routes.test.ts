// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  after: vi.fn(),
  finishSignIn: vi.fn(),
  syncInstagram: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/bank/server", () => {
  class NotOwnerError extends Error {}
  return { NotOwnerError, requireOwner: mocks.requireOwner };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/instagram/sync", () => ({ syncInstagram: mocks.syncInstagram }));
vi.mock("@/lib/instagram/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instagram/oauth")>()),
  finishSignIn: mocks.finishSignIn,
}));

const { NotOwnerError } = await import("@/lib/bank/server");
const { InstagramError } = await import("@/lib/instagram/client");
const start = await import("./start/route");
const callback = await import("./callback/route");
const cron = await import("./cron/route");

const ORIGIN = "https://hydra.example";
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { headers });
const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0].split("=").slice(1).join("=");

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("META_APP_ID", "1234567890");
  vi.stubEnv("META_APP_SECRET", "app-secret");
  vi.stubEnv("INSTAGRAM_CONFIG_ID", "cfg-777");
  vi.stubEnv("HYDRA_TOKEN_KEY", Buffer.alloc(32, 7).toString("base64"));
  mocks.requireOwner.mockResolvedValue({ db: {}, userId: "owner" });
  mocks.finishSignIn.mockResolvedValue({ username: "studio.notes" });
  mocks.syncInstagram.mockResolvedValue({ readings: 3 });
});

async function started(from = "") {
  const res = await start.GET(get(`/api/instagram/start${from}`));
  return { res, state: new URL(res.headers.get("location")!).searchParams.get("state")!, cookie: cookieOf(res) };
}

describe("GET /api/instagram/start", () => {
  it("sends the owner to the Unified login dialog and sets the httpOnly state cookie on /api/instagram", async () => {
    const { res, state } = await started();
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(location.searchParams.get("config_id")).toBe("cfg-777");
    expect(location.searchParams.get("client_id")).toBe("1234567890");
    expect(location.searchParams.has("scope")).toBe(false);
    expect(res.headers.get("set-cookie")).toBe(`hydra_instagram_oauth=${state}.brand; Path=/api/instagram; HttpOnly; SameSite=Lax; Max-Age=600; Secure`);
    expect((await started("?from=settings")).cookie).toMatch(/\.settings$/);
    expect((await started("?from=https://evil.example")).cookie).toMatch(/\.brand$/);
  });

  it("refuses anyone but the owner, and fails closed without the app env", async () => {
    mocks.requireOwner.mockRejectedValueOnce(new NotOwnerError());
    expect((await start.GET(get("/api/instagram/start"))).status).toBe(403);
    vi.stubEnv("INSTAGRAM_CONFIG_ID", "");
    const res = await start.GET(get("/api/instagram/start"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "not_configured", message: expect.stringContaining("INSTAGRAM_CONFIG_ID") } });
  });
});

describe("GET /api/instagram/callback", () => {
  it("refuses a missing, wrong or replayed state before any exchange", async () => {
    const { state, cookie } = await started();
    const missing = await callback.GET(get(`/api/instagram/callback?code=c&state=${state}`));
    const wrong = await callback.GET(get(`/api/instagram/callback?code=c&state=other`, { cookie: `hydra_instagram_oauth=${cookie}` }));
    const none = await callback.GET(get(`/api/instagram/callback?code=c`, { cookie: `hydra_instagram_oauth=${cookie}` }));
    for (const res of [missing, wrong, none]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "bad_state" } });
      expect(res.headers.get("set-cookie")).toMatch(/^hydra_instagram_oauth=; .*Max-Age=0/);
    }
    expect(mocks.finishSignIn).not.toHaveBeenCalled();
  });

  it("a matching state exchanges the code once, clears the cookie, syncs after the response, and goes back", async () => {
    const { state, cookie } = await started();
    const res = await callback.GET(get(`/api/instagram/callback?code=good&state=${state}`, { cookie: `other=1; hydra_instagram_oauth=${cookie}` }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/brand?instagram=connected`);
    expect(res.headers.get("set-cookie")).toMatch(/^hydra_instagram_oauth=; .*Max-Age=0/);
    expect(mocks.finishSignIn).toHaveBeenCalledWith({ code: "good", requestUrl: expect.stringContaining("/api/instagram/callback") });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.syncInstagram).toHaveBeenCalledTimes(1);
    // The browser dropped the cookie (Max-Age=0): the same state again has nothing to match.
    const replay = await callback.GET(get(`/api/instagram/callback?code=good&state=${state}`));
    expect(replay.status).toBe(400);
    expect(mocks.finishSignIn).toHaveBeenCalledTimes(1);
  });

  it("goes back to Settings when it started there; a cancel or a failed exchange says so", async () => {
    const s = await started("?from=settings");
    const ok = await callback.GET(get(`/api/instagram/callback?code=good&state=${s.state}`, { cookie: `hydra_instagram_oauth=${s.cookie}` }));
    expect(ok.headers.get("location")).toBe(`${ORIGIN}/settings?tab=connections&instagram=connected`);
    const c = await started();
    const denied = await callback.GET(get(`/api/instagram/callback?error=access_denied&state=${c.state}`, { cookie: `hydra_instagram_oauth=${c.cookie}` }));
    expect(denied.headers.get("location")).toBe(`${ORIGIN}/brand?instagram=denied`);
    mocks.finishSignIn.mockRejectedValueOnce(new InstagramError("instagram_error", "x"));
    const f = await started();
    const failed = await callback.GET(get(`/api/instagram/callback?code=bad&state=${f.state}`, { cookie: `hydra_instagram_oauth=${f.cookie}` }));
    expect(failed.headers.get("location")).toBe(`${ORIGIN}/brand?instagram=error`);
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("refuses anyone but the owner", async () => {
    mocks.requireOwner.mockRejectedValueOnce(new NotOwnerError());
    expect((await callback.GET(get("/api/instagram/callback?code=c&state=s"))).status).toBe(403);
  });
});

describe("GET /api/instagram/cron", () => {
  it("needs Bearer CRON_SECRET and fails closed without it", async () => {
    expect((await cron.GET(get("/api/instagram/cron", { authorization: "Bearer x" }))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await cron.GET(get("/api/instagram/cron", { authorization: "Bearer nope" }))).status).toBe(401);
    expect(mocks.syncInstagram).not.toHaveBeenCalled();
    const res = await cron.GET(get("/api/instagram/cron", { authorization: "Bearer s3cret" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sync: { ok: true } });
  });

  it("not connected or waiting on a Reconnect is no failure; a throttle is", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const auth = { authorization: "Bearer s3cret" };
    mocks.syncInstagram.mockRejectedValueOnce(new InstagramError("not_connected", "x"));
    expect((await cron.GET(get("/api/instagram/cron", auth))).status).toBe(200);
    mocks.syncInstagram.mockRejectedValueOnce(new InstagramError("reauth_required", "x"));
    expect((await cron.GET(get("/api/instagram/cron", auth))).status).toBe(200);
    mocks.syncInstagram.mockRejectedValueOnce(new InstagramError("rate_limited", "x"));
    expect((await cron.GET(get("/api/instagram/cron", auth))).status).toBe(500);
  });
});
