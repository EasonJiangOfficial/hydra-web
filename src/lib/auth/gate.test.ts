import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isOwnerEmail, isPublicPath, isSelfAuthPath, loginPath, safeNext, signedInLoginRedirect } from "./gate";

describe("safeNext", () => {
  it.each([
    ["/planning", "/planning"],
    ["/ugc?tab=deals#x", "/ugc?tab=deals#x"],
    [null, "/"],
    ["", "/"],
    ["https://evil.example", "/"],
    ["//evil.example/x", "/"],
    ["/\\evil.example", "/"],
    ["javascript:alert(1)", "/"],
    ["/login?next=/x", "/"],
    ["/auth/signout", "/"],
    ["/%2F%2Fevil.example", "/%2F%2Fevil.example"],
    // The parser resolves dot segments and drops tabs/newlines: these all parse to `//evil.com`.
    ["/.//evil.com", "/"],
    ["/%2e//evil.com", "/"],
    ["/%2E//evil.com", "/"],
    ["/a/..//evil.com", "/"],
    ["/a/%2e%2e//evil.com", "/"],
    ["/%2E%2E//evil.com", "/"],
    ["/%2e%2E//evil.com", "/"],
    ["/x/../\t/evil.com", "/"],
    ["/./\t/evil.com", "/"],
    ["/.\n//evil.com", "/"],
    ["/\t/evil.com", "/"],
    ["/\r\n/evil.com", "/"],
    ["/./\\evil.com", "/"],
    ["/a/../\\evil.com", "/"],
    ["/.//evil.com/x?y=1#z", "/"],
    ["/%2e%2e/login", "/"],
    // Encoded slashes and backslashes stay encoded: a same-origin path, not a host.
    ["/%5Cevil.com", "/%5Cevil.com"],
    ["/a/./b/../c", "/a/c"],
  ])("%j -> %s", (raw, want) => {
    expect(safeNext(raw)).toBe(want);
  });

  it("never returns anything the browser would read as another origin", () => {
    const cases = ["/.//evil.com", "/%2e//evil.com", "/a/..//evil.com", "/x/../\t/evil.com", "/./\\evil.com"];
    for (const raw of cases) {
      expect(new URL(safeNext(raw), "https://hydra.example").origin).toBe("https://hydra.example");
    }
  });
});

describe("isPublicPath", () => {
  it.each([
    ["/login", true],
    ["/auth/signout", true],
    ["/dev/auth-lock", true],
    ["/", false],
    ["/planning", false],
    ["/loginx", false],
    ["/developer", false],
  ])("%s -> %s", (path, want) => expect(isPublicPath(path)).toBe(want));
});

describe("isSelfAuthPath", () => {
  it.each([
    "/api/ugc/v1",
    "/api/ugc/v1/context",
    "/api/ugc/v1/posts",
    "/api/ugc/v1/views",
    "/api/mcp/ugc",
    "/api/mcp/agent",
    "/api/agent/turn",
    "/api/agent/state",
    "/api/agent/devices/exchange",
    "/api/cron/agent",
    "/api/cron/bank",
    "/api/cron/planning",
    "/api/google/cron",
    "/api/google/calendar/webhook",
    "/api/instagram/cron",
    "/api/plaid/webhook",
    "/api/voice/tts",
  ])("%s is let through", (path) => expect(isSelfAuthPath(path)).toBe(true));

  it.each([
    "/",
    "/planning",
    "/api",
    "/api/agent-x",
    "/api/agentx/turn",
    "/api/ugc",
    "/api/ugc/v1x",
    "/api/ugc/v2/context",
    "/api/mcp",
    "/api/mcp/ugcx",
    "/api/mcp/other",
    "/api/cron",
    "/api/cron/other",
    "/api/cron/agentx",
    "/api/cron/bankx",
    "/api/cron/bank-sync",
    "/api/cron/planningx",
    "/api/cron/planning.json",
    "/api/cronbank",
    "/x/api/cron/bank",
    "/api/google/start",
    "/api/google/callback",
    "/api/google/disconnect",
    "/api/google/calendar",
    "/api/google/cronx",
    "/api/instagram/start",
    "/api/instagram/callback",
    "/api/instagram/cronx",
    "/api/plaid/exchange",
    "/api/plaid/link-token",
    "/api/plaid/webhooks",
    "/api/push/subscribe",
    "/api/voice",
    "/api/voice/ttsx",
    "/api/voice/other",
    "/x/api/agent/turn",
  ])("%s stays gated", (path) => expect(isSelfAuthPath(path)).toBe(false));
});

describe("vercel.json crons", () => {
  // Vercel calls each cron with only `Authorization: Bearer $CRON_SECRET`: a gated path would 307 to /login and never run.
  const crons: Array<{ path: string; schedule: string }> = JSON.parse(
    readFileSync(path.join(process.cwd(), "vercel.json"), "utf8"),
  ).crons;

  it("schedules the daily bank and planning jobs", () => {
    expect(crons).toEqual(
      expect.arrayContaining([
        { path: "/api/cron/bank", schedule: "0 10 * * *" },
        { path: "/api/cron/planning", schedule: "15 9 * * *" },
      ]),
    );
  });

  it("every cron path skips the owner gate", () => {
    for (const { path: p } of crons) expect(isSelfAuthPath(p), p).toBe(true);
  });
});

describe("isOwnerEmail", () => {
  it("matches case-insensitively and rejects others", () => {
    expect(isOwnerEmail("Owner@Example.com", "owner@example.com")).toBe(true);
    expect(isOwnerEmail("other@example.com", "owner@example.com")).toBe(false);
    expect(isOwnerEmail(undefined, "owner@example.com")).toBe(false);
    expect(isOwnerEmail("", "")).toBe(false);
  });
});

describe("loginPath", () => {
  it("carries the path and query", () => {
    expect(loginPath("/planning", "?view=board")).toBe("/login?next=%2Fplanning%3Fview%3Dboard");
    expect(loginPath("/")).toBe("/login?next=%2F");
  });
});

describe("signedInLoginRedirect", () => {
  it.each([
    // Signed-in owner: skip the login page.
    ["", true, "/"],
    ["?next=%2Fplanning", true, "/planning"],
    ["?next=%2Fugc%3Ftab%3Ddeals", true, "/ugc?tab=deals"],
    // next still runs through safeNext: never off-origin, never back to /login.
    ["?next=https%3A%2F%2Fevil.example", true, "/"],
    ["?next=%2F%2Fevil.example", true, "/"],
    ["?next=%2F.%2F%2Fevil.com", true, "/"],
    ["?next=%2Flogin", true, "/"],
    // The add-a-passkey step and an error message still render the login page.
    ["?step=passkey&next=%2F", true, null],
    ["?error=link", true, null],
    ["?error=", true, null],
    // A different step value is not the passkey step.
    ["?step=other", true, "/"],
    // Not the owner (or signed out): the login page renders.
    ["", false, null],
    ["?next=%2Fplanning", false, null],
  ])("%j owner=%s -> %j", (search, isOwner, want) => {
    expect(signedInLoginRedirect(new URLSearchParams(search), isOwner)).toBe(want);
  });
});
