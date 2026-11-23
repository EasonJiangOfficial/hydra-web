// @vitest-environment node
import { NextRequest } from "next/server";
import { getRedirectUrl, unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { config, proxy } from "./proxy";

const ORIGIN = "https://hydra.example";
const run = (path: string, init?: { method?: string; headers?: Record<string, string> }) =>
  proxy(new NextRequest(`${ORIGIN}${path}`, init));
const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:9");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("HYDRA_OWNER_EMAIL", "owner@example.test");
});

describe("proxy, no owner session", () => {
  it.each([
    ["GET", "/api/ugc/v1/context"],
    ["POST", "/api/ugc/v1/views"],
    ["POST", "/api/mcp/ugc"],
    ["POST", "/api/agent/turn"],
    ["GET", "/api/agent/state"],
    ["POST", "/api/agent/devices/exchange"],
    ["POST", "/api/mcp/agent"],
    ["GET", "/api/cron/agent"],
    ["GET", "/api/cron/bank"],
    ["GET", "/api/cron/planning"],
    ["GET", "/api/google/cron"],
    ["POST", "/api/google/calendar/webhook"],
    ["GET", "/api/instagram/cron"],
    ["POST", "/api/plaid/webhook"],
    ["POST", "/api/voice/tts"],
  ])("%s %s reaches its handler (no /login redirect)", async (method, path) => {
    const res = await run(path, { method, headers: { authorization: "Bearer x" } });
    expect(passes(res)).toBe(true);
    expect(getRedirectUrl(res)).toBeNull();
  });

  it.each(["/", "/planning", "/api/agent-x", "/api/ugc/v1x", "/api/google/start", "/api/instagram/start", "/api/plaid/exchange", "/api/push/subscribe", "/api/voice/ttsx", "/api/cron/bankx", "/api/cron/planning-x"])(
    "%s still goes to /login",
    async (path) => {
      const res = await run(path, { headers: { authorization: "Bearer x" } });
      expect(getRedirectUrl(res)).toContain("/login?next=");
    },
  );

  it("Accounts > Connections moved to Settings: the old link goes there first, with its params", async () => {
    expect(getRedirectUrl(await run("/accounts?tab=connections&google=connected"))).toBe(`${ORIGIN}/settings?tab=connections&google=connected`);
    expect(getRedirectUrl(await run("/accounts?tab=recurring"))).toContain("/login?next=");
    expect(getRedirectUrl(await run("/settings?tab=connections"))).toBe(`${ORIGIN}/login?next=${encodeURIComponent("/settings?tab=connections")}`);
  });

  it("fails open only for self-auth routes when env is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(passes(await run("/api/plaid/webhook", { method: "POST" }))).toBe(true);
    expect(getRedirectUrl(await run("/planning"))).toContain("/login");
  });
});

describe("proxy matcher", () => {
  it.each(["/sw.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png"])("%s skips the proxy (static)", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
  });
  it.each(["/", "/planning", "/sw.jsx", "/api/agent/turn", "/api/plaid/webhook"])("%s runs the proxy", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
  });
});
