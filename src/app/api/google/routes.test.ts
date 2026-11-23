// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissingEnvError } from "@/lib/bank/env";

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  after: vi.fn(),
  finishSignIn: vi.fn(),
  disconnect: vi.fn(),
  startWatch: vi.fn(),
  pushAll: vi.fn(),
  pullCalendar: vi.fn(),
  renewWatch: vi.fn(),
  verifyNotification: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/bank/server", () => {
  class NotOwnerError extends Error {}
  return { NotOwnerError, requireOwner: mocks.requireOwner };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/google/calendar", () => ({
  startWatch: mocks.startWatch,
  pushAll: mocks.pushAll,
  pullCalendar: mocks.pullCalendar,
  renewWatch: mocks.renewWatch,
  verifyNotification: mocks.verifyNotification,
}));
vi.mock("@/lib/google/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/oauth")>()),
  finishSignIn: mocks.finishSignIn,
  disconnect: mocks.disconnect,
}));

const { NotOwnerError } = await import("@/lib/bank/server");
const start = await import("./start/route");
const callback = await import("./callback/route");
const disconnect = await import("./disconnect/route");
const webhook = await import("./calendar/webhook/route");
const cron = await import("./cron/route");

const ORIGIN = "https://hydra.example";
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { headers });

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
  mocks.requireOwner.mockResolvedValue({ db: {}, userId: "owner" });
  mocks.finishSignIn.mockResolvedValue({ id: "acc", email: "owner@example.test", scopes: "", status: "active" });
  mocks.startWatch.mockResolvedValue({ ok: true, data: { channelId: "c1", expiresAt: "x" } });
  mocks.pushAll.mockResolvedValue({ ok: true, data: { pushed: 0 } });
  mocks.pullCalendar.mockResolvedValue({ ok: true, data: {} });
  mocks.renewWatch.mockResolvedValue({ ok: true, data: { renewed: 0 } });
});

describe("GET /api/google/start", () => {
  it("sends the owner to Google and sets the httpOnly state cookie", async () => {
    const res = await start.GET(get("/api/google/start"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    const state = new URL(res.headers.get("location")!).searchParams.get("state");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^hydra_google_oauth=${state}\\.[A-Za-z0-9_-]+; Path=/api/google; HttpOnly; SameSite=Lax; Max-Age=600; Secure$`));
  });

  it("refuses anyone but the owner, and fails closed without the client env", async () => {
    mocks.requireOwner.mockRejectedValueOnce(new NotOwnerError());
    expect((await start.GET(get("/api/google/start"))).status).toBe(403);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    const res = await start.GET(get("/api/google/start"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "not_configured" } });
  });
});

describe("GET /api/google/callback: state check", () => {
  const cookie = { cookie: "sb-auth=1; hydra_google_oauth=state-good.verifier-1" };

  it("refuses a state that does not match the cookie, and exchanges nothing", async () => {
    for (const req of [
      get("/api/google/callback?code=c&state=state-evil", cookie),
      get("/api/google/callback?code=c&state=state-good"),
      get("/api/google/callback?code=c", cookie),
    ]) {
      const res = await callback.GET(req);
      expect(res.status).toBe(400);
      expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    }
    expect(mocks.finishSignIn).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("with the matching state: exchanges the code with the cookie's verifier, watches, syncs after the response", async () => {
    const res = await callback.GET(get("/api/google/callback?code=good-code&state=state-good", cookie));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/settings?tab=connections&google=connected`);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(mocks.finishSignIn).toHaveBeenCalledWith({ code: "good-code", verifier: "verifier-1", requestUrl: expect.stringContaining("/api/google/callback") });
    expect(mocks.startWatch).toHaveBeenCalledWith(`${ORIGIN}/api/google/calendar/webhook`);
    expect(mocks.pullCalendar).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0]();
    expect(mocks.pushAll).toHaveBeenCalled();
    expect(mocks.pullCalendar).toHaveBeenCalled();
  });

  it("the owner pressing Cancel lands back on Settings; a failed exchange says error", async () => {
    const denied = await callback.GET(get("/api/google/callback?error=access_denied&state=state-good", cookie));
    expect(denied.headers.get("location")).toBe(`${ORIGIN}/settings?tab=connections&google=denied`);
    mocks.finishSignIn.mockRejectedValueOnce(new MissingEnvError("GOOGLE_CLIENT_ID"));
    const failed = await callback.GET(get("/api/google/callback?code=c&state=state-good", cookie));
    expect(failed.headers.get("location")).toBe(`${ORIGIN}/settings?tab=connections&google=not_configured`);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("does not register a watch channel for localhost", async () => {
    await callback.GET(new Request("http://localhost:3000/api/google/callback?code=c&state=state-good", { headers: cookie }));
    expect(mocks.startWatch).not.toHaveBeenCalled();
  });
});

describe("POST /api/google/disconnect", () => {
  it("needs JSON and the owner", async () => {
    const form = new Request(`${ORIGIN}/api/google/disconnect`, { method: "POST", body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect((await disconnect.POST(form)).status).toBe(415);
    mocks.disconnect.mockResolvedValue({ disconnected: true });
    const json = new Request(`${ORIGIN}/api/google/disconnect`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    const res = await disconnect.POST(json);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { disconnected: true } });
  });
});

describe("POST /api/google/calendar/webhook", () => {
  const notify = (state = "exists") =>
    new Request(`${ORIGIN}/api/google/calendar/webhook`, { method: "POST", headers: { "x-goog-channel-id": "c1", "x-goog-resource-state": state } });

  it("refuses an unverified notification and pulls nothing", async () => {
    mocks.verifyNotification.mockResolvedValue({ ok: false });
    expect((await webhook.POST(notify())).status).toBe(401);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("pulls after the response on a change, not on the first sync message", async () => {
    mocks.verifyNotification.mockResolvedValue({ ok: true, state: "sync" });
    expect((await webhook.POST(notify("sync"))).status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled();
    mocks.verifyNotification.mockResolvedValue({ ok: true, state: "exists" });
    expect((await webhook.POST(notify())).status).toBe(200);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.pullCalendar).toHaveBeenCalledTimes(1);
  });

  it("answers 503 (Google retries) when Hydra cannot check it", async () => {
    mocks.verifyNotification.mockRejectedValue(new MissingEnvError("SUPABASE_SECRET_KEY"));
    expect((await webhook.POST(notify())).status).toBe(503);
  });
});

describe("GET /api/google/cron", () => {
  it("fails closed without CRON_SECRET and refuses a wrong one", async () => {
    expect((await cron.GET(get("/api/google/cron", { authorization: "Bearer x" }))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await cron.GET(get("/api/google/cron", { authorization: "Bearer wrong" }))).status).toBe(401);
    expect(mocks.renewWatch).not.toHaveBeenCalled();
    const res = await cron.GET(get("/api/google/cron", { authorization: "Bearer s3cret" }));
    expect(res.status).toBe(200);
    expect(mocks.renewWatch).toHaveBeenCalled();
    expect(mocks.pullCalendar).toHaveBeenCalled();
  });
});
