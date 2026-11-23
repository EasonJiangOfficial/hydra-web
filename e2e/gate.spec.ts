import { expect, test } from "@playwright/test";

/* The auth gate (src/lib/auth/gate.ts isSelfAuthPath): machine-called API routes reach their own
   handler with no owner session, and the handler refuses: JSON, never a redirect to /login, never 200.
   Cron routes answer 503 until CRON_SECRET is set, the Plaid webhook until the Plaid keys are set
   (fail closed); with them set (the server inherits this process's env) they answer 401. */

const cronWant = process.env.CRON_SECRET ? 401 : 503;
const plaidWant = process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET ? 401 : 503;
const ID = "00000000-0000-4000-8000-000000000001";

const opened: Array<[method: "GET" | "POST", path: string, want: number, body?: unknown]> = [
  ["GET", "/api/ugc/v1/context", 401],
  ["GET", "/api/ugc/v1/posts?needsViews=1", 401],
  ["POST", "/api/ugc/v1/posts", 401, {}],
  ["POST", "/api/ugc/v1/views", 401, {}],
  ["POST", "/api/mcp/ugc", 401, {}],
  ["POST", "/api/agent/turn", 401, { input: { text: "hi" }, surface: "web" }],
  ["POST", "/api/agent/confirm", 401, { id: ID, approve: true }],
  ["GET", "/api/agent/state", 401],
  ["POST", "/api/agent/undo", 401, { actionId: ID }],
  ["GET", "/api/agent/jobs", 401],
  ["GET", "/api/agent/devices", 401],
  ["POST", "/api/agent/devices/pair", 401, {}],
  ["POST", "/api/agent/devices/revoke", 401, { id: ID }],
  ["POST", "/api/agent/routines/run", 401, { runId: ID }],
  ["POST", "/api/mcp/agent", 401, {}],
  ["GET", "/api/mcp/agent", 401],
  // The pairing exchange takes no session: the one-time code is the proof. A bad body is refused.
  ["POST", "/api/agent/devices/exchange", 400, {}],
  ["GET", "/api/cron/agent", cronWant],
  ["GET", "/api/google/cron", cronWant],
  ["POST", "/api/google/calendar/webhook", 401],
  ["POST", "/api/plaid/webhook", plaidWant, { webhook_type: "TRANSACTIONS" }],
];

test.describe("self-auth API routes, no session", () => {
  test.skip(({ isMobile }) => isMobile, "request-level check; one project is enough");

  for (const [method, path, want, body] of opened) {
    test(`${method} ${path} -> ${want}`, async ({ request }) => {
      const res = await request.fetch(path, { method, data: body, maxRedirects: 0 });
      expect(res.status()).toBe(want);
      expect(res.headers()["location"]).toBeUndefined();
      expect(res.headers()["content-type"]).toContain("application/json");
    });
  }

  // Daily crons (vercel.json). R4 builds /api/cron/bank and R3 /api/cron/planning; on a branch without the
  // handler the gate still lets the request through (404 from Next, never a /login redirect).
  for (const path of ["/api/cron/bank", "/api/cron/planning"]) {
    test(`GET ${path} -> ${cronWant} (gate lets it through)`, async ({ request }) => {
      const res = await request.fetch(path, { method: "GET", maxRedirects: 0 });
      expect(res.headers()["location"]).toBeUndefined();
      test.skip(res.status() === 404, `${path} has no handler on this branch`);
      expect(res.status()).toBe(cronWant);
      expect(res.headers()["content-type"]).toContain("application/json");
    });
  }

  test("owner-only APIs and look-alike paths still go to /login", async ({ request }) => {
    for (const path of ["/api/agent-x", "/api/ugc/v1x", "/api/push/subscribe", "/api/google/start", "/api/cron/bankx", "/api/cron/planning-x"]) {
      const res = await request.fetch(path, { method: "GET", maxRedirects: 0 });
      expect(res.status(), path).toBe(307);
      expect(res.headers()["location"], path).toContain("/login?next=");
    }
  });
});
