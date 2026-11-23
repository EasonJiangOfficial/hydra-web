// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptToken, encryptToken } from "@/lib/bank/crypto";
import { MissingEnvError } from "@/lib/bank/env";
import { fakeGoogle, memoryDb } from "./fixtures";

const mocks = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));

const { checkState, disconnect, finishSignIn, GOOGLE_SCOPES, startSignIn } = await import("./oauth");
const { googleApi, run } = await import("./client");

const ACCOUNT = "aaaaaaaa-0000-4000-8000-000000000001";
const CALENDARS = "https://www.googleapis.com/calendar/v3/calendars";
let google: ReturnType<typeof fakeGoogle>;
let store: ReturnType<typeof memoryDb>;

const account = (over: Record<string, unknown> = {}) => ({
  id: ACCOUNT,
  email: "owner@example.test",
  scopes: "",
  status: "active",
  access_token: encryptToken("access-1", ACCOUNT),
  access_expires_at: "2026-11-21T20:00:00Z",
  refresh_token: encryptToken("refresh-1", ACCOUNT),
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T15:00:00Z"));
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
  vi.stubEnv("HYDRA_TOKEN_KEY", Buffer.alloc(32, 7).toString("base64"));
  google = fakeGoogle();
  vi.stubGlobal("fetch", vi.fn(google.fetch));
  store = memoryDb({ google_accounts: [] });
  mocks.db = store.db;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sign-in (OAuth 2.0 + PKCE)", () => {
  it("sends the owner to Google with S256 PKCE, offline access and the Gmail and Calendar scopes", () => {
    const { url, cookie } = startSignIn("https://hydra.example/api/google/start");
    const u = new URL(url);
    const [state, verifier] = cookie.split(".");
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: "client-id",
      redirect_uri: "https://hydra.example/api/google/callback",
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      state,
    });
    expect(u.searchParams.get("scope")!.split(" ")).toEqual([...GOOGLE_SCOPES]);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("fails closed without GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    expect(() => startSignIn("https://hydra.example/api/google/start")).toThrow(MissingEnvError);
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", " ");
    store.rows("google_accounts").push(account());
    expect(await run(() => googleApi(CALENDARS))).toMatchObject({ ok: false, error: { code: "not_configured" } });
    expect(google.calls).toEqual([]);
  });

  it("checks the callback state against the cookie", () => {
    expect(checkState("state-1.verifier-1", "state-1")).toBe("verifier-1");
    expect(checkState("state-1.verifier-1", "state-2")).toBeNull();
    expect(checkState("state-1.verifier-1", null)).toBeNull();
    expect(checkState(undefined, "state-1")).toBeNull();
    expect(checkState("state-1", "state-1")).toBeNull();
  });

  it("exchanges the code with its verifier and stores both tokens encrypted", async () => {
    const saved = await finishSignIn({ code: "good-code", verifier: "v".repeat(64), requestUrl: "https://hydra.example/api/google/callback?code=x" });
    expect(saved).toMatchObject({ email: "owner@example.test", status: "active" });
    const exchange = google.calls[0].body as Record<string, string>;
    expect(exchange).toMatchObject({ grant_type: "authorization_code", code_verifier: "v".repeat(64), redirect_uri: "https://hydra.example/api/google/callback" });
    const [row] = store.rows("google_accounts");
    expect(row.access_token).toMatch(/^v1\./);
    expect(row.refresh_token).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain("refresh-1");
    expect(decryptToken(row.refresh_token as string, row.id as string)).toBe("refresh-1");
    expect(decryptToken(row.access_token as string, row.id as string)).toBe("access-1");
  });

  it("a different Google account replaces the old one and its sync state", async () => {
    store.rows("google_accounts").push(account({ email: "old@example.test" }));
    store.rows("google_calendar_sync").push({ account_id: ACCOUNT, calendar_id: "old-cal", sync_token: "9" });
    const saved = await finishSignIn({ code: "good-code", verifier: "v".repeat(64), requestUrl: "https://hydra.example/api/google/callback" });
    expect(saved.id).not.toBe(ACCOUNT);
    expect(store.rows("google_accounts")).toHaveLength(1);
    expect(store.rows("google_calendar_sync")).toEqual([]);
  });

  it("disconnect revokes at Google and deletes the tokens", async () => {
    store.rows("google_accounts").push(account());
    expect(await disconnect()).toEqual({ disconnected: true });
    expect(google.calls[0]).toMatchObject({ method: "POST", body: { token: "refresh-1" } });
    expect(google.calls[0].url.pathname).toBe("/revoke");
    expect(store.rows("google_accounts")).toEqual([]);
  });
});

describe("token refresh", () => {
  it("refreshes an expired access token, stores it encrypted and uses it", async () => {
    store.rows("google_accounts").push(account({ access_expires_at: "2026-11-21T15:00:30Z" })); // inside the 1-minute skew
    await googleApi(CALENDARS, { method: "POST", body: { summary: "Hydra" } });
    expect(google.calls[0].body).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-1", client_secret: "client-secret" });
    expect(google.calls[1].auth).toBe("Bearer access-2");
    const [row] = store.rows("google_accounts");
    expect(decryptToken(row.access_token as string, ACCOUNT)).toBe("access-2");
    expect(row.access_expires_at).toBe("2026-11-21T16:00:00.000Z");
  });

  it("refreshes once and retries when Google answers 401", async () => {
    store.rows("google_accounts").push(account());
    google.state.accessToken = "access-revoked-elsewhere";
    await googleApi(CALENDARS, { method: "POST", body: { summary: "Hydra" } });
    expect(google.calls.map((c) => c.url.pathname)).toEqual(["/calendar/v3/calendars", "/token", "/calendar/v3/calendars"]);
  });

  it("marks the account for a new sign-in when Google refuses the refresh token", async () => {
    store.rows("google_accounts").push(account({ access_expires_at: "2026-11-21T14:00:00Z" }));
    google.state.refreshFails = true;
    expect(await run(() => googleApi(CALENDARS))).toMatchObject({ ok: false, error: { code: "reauth_required" } });
    expect(store.rows("google_accounts")[0]).toMatchObject({ status: "reauth_required", last_error: "invalid_grant" });
    expect(await run(() => googleApi(CALENDARS))).toMatchObject({ ok: false, error: { code: "reauth_required" } });
    expect(google.calls).toHaveLength(1);
  });
});
