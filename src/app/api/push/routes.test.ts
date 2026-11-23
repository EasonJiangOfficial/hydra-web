// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireOwner: vi.fn(), upsert: vi.fn(), deleteEq: vi.fn() }));

vi.mock("@/lib/bank/server", () => ({
  requireOwner: mocks.requireOwner,
  NotOwnerError: class NotOwnerError extends Error {},
}));

const subscribe = await import("./subscribe/route");
const unsubscribe = await import("./unsubscribe/route");
const key = await import("./key/route");
const { NotOwnerError } = await import("@/lib/bank/server");

const SUB = { endpoint: "https://push.example/abc", keys: { p256dh: "pk", auth: "ak" } };
const post = (url: string, body: unknown, type: string | null = "application/json") =>
  new Request(`https://hydra.example/api/push/${url}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { ...(type ? { "content-type": type } : {}), "user-agent": "Test Phone" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upsert.mockResolvedValue({ error: null });
  mocks.deleteEq.mockResolvedValue({ error: null });
  mocks.requireOwner.mockResolvedValue({
    userId: "owner-1",
    db: { from: () => ({ upsert: mocks.upsert, delete: () => ({ eq: mocks.deleteEq }) }) },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/push/subscribe", () => {
  it("stores the subscription for the owner, keyed by endpoint", async () => {
    const res = await subscribe.POST(post("subscribe", SUB));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { saved: true } });
    expect(mocks.upsert).toHaveBeenCalledWith(
      { user_id: "owner-1", endpoint: SUB.endpoint, p256dh: "pk", auth: "ak", user_agent: "Test Phone" },
      { onConflict: "endpoint" },
    );
  });

  it("refuses a non-owner with 403 and writes nothing", async () => {
    mocks.requireOwner.mockRejectedValue(new NotOwnerError());
    expect((await subscribe.POST(post("subscribe", SUB))).status).toBe(403);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["an http endpoint", { ...SUB, endpoint: "http://push.example/abc" }],
    ["a missing key", { endpoint: SUB.endpoint, keys: { p256dh: "pk" } }],
    ["a string", "{}"],
  ])("refuses %s with 400", async (_name, body) => {
    expect((await subscribe.POST(post("subscribe", body))).status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("requires a JSON content type", async () => {
    expect((await subscribe.POST(post("subscribe", SUB, "text/plain"))).status).toBe(415);
  });

  it("answers 500 when the database refuses", async () => {
    mocks.upsert.mockResolvedValue({ error: { message: "nope" } });
    expect((await subscribe.POST(post("subscribe", SUB))).status).toBe(500);
  });
});

describe("POST /api/push/unsubscribe", () => {
  it("deletes the owner's row for that endpoint", async () => {
    const res = await unsubscribe.POST(post("unsubscribe", { endpoint: SUB.endpoint }));
    expect(res.status).toBe(200);
    expect(mocks.deleteEq).toHaveBeenCalledWith("endpoint", SUB.endpoint);
  });

  it("refuses a non-owner and a body with no endpoint", async () => {
    expect((await unsubscribe.POST(post("unsubscribe", {}))).status).toBe(400);
    mocks.requireOwner.mockRejectedValue(new NotOwnerError());
    expect((await unsubscribe.POST(post("unsubscribe", { endpoint: SUB.endpoint }))).status).toBe(403);
    expect(mocks.deleteEq).not.toHaveBeenCalled();
  });
});

describe("GET /api/push/key", () => {
  it("returns only the public key", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "pub");
    vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
    vi.stubEnv("VAPID_SUBJECT", "mailto:o@example.test");
    const res = await key.GET();
    expect(await res.json()).toEqual({ ok: true, data: { publicKey: "pub" } });
  });

  it("answers 503 until the server has VAPID keys", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "");
    expect((await key.GET()).status).toBe(503);
  });
});
