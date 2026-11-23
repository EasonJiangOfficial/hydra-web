// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("web-push", () => ({ setVapidDetails: mocks.setVapidDetails, sendNotification: mocks.sendNotification }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));

const { sendPush } = await import("./send");

type Row = { id: string; endpoint: string; p256dh: string; auth: string };
const ROWS: Row[] = [
  { id: "a", endpoint: "https://push.example/a", p256dh: "pa", auth: "aa" },
  { id: "b", endpoint: "https://push.example/b", p256dh: "pb", auth: "ab" },
  { id: "c", endpoint: "https://push.example/c", p256dh: "pc", auth: "ac" },
];

let deleted: string[][];
function db(rows: Row[], error: { message: string } | null = null) {
  return {
    from: (table: string) => {
      expect(table).toBe("push_subscriptions");
      return {
        select: () => Promise.resolve({ data: rows, error }),
        delete: () => ({
          in: (column: string, ids: string[]) => {
            expect(column).toBe("id");
            deleted.push(ids);
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };
}
const gone = (statusCode: number) => Object.assign(new Error("push service"), { statusCode });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setVapidDetails.mockReset();
  deleted = [];
  vi.stubEnv("VAPID_PUBLIC_KEY", "pub");
  vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
  vi.stubEnv("VAPID_SUBJECT", "mailto:owner@example.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.createAdminClient.mockReturnValue(db(ROWS));
  mocks.sendNotification.mockResolvedValue({ statusCode: 201 });
});
afterEach(() => vi.unstubAllEnvs());

describe("sendPush", () => {
  it("sends the payload to every subscription with the VAPID identity", async () => {
    const result = await sendPush({ title: "Send the W-9", body: "Due at 6", url: "/planning", tag: "r1" });
    expect(result).toEqual({ ok: true, sent: 3, pruned: 0, failed: 0 });
    expect(mocks.setVapidDetails).toHaveBeenCalledWith("mailto:owner@example.test", "pub", "priv");
    expect(mocks.sendNotification).toHaveBeenCalledTimes(3);
    const [sub, body, options] = mocks.sendNotification.mock.calls[0];
    expect(sub).toEqual({ endpoint: "https://push.example/a", keys: { p256dh: "pa", auth: "aa" } });
    expect(JSON.parse(body)).toEqual({ title: "Send the W-9", body: "Due at 6", url: "/planning", tag: "r1" });
    expect(options).toEqual({ TTL: 86400 });
  });

  it.each(["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"])("fails closed when %s is missing", async (name) => {
    vi.stubEnv(name, "");
    const result = await sendPush({ title: "x" });
    expect(result).toEqual({ ok: false, code: "not_configured", message: `Missing environment variable ${name}` });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("fails closed when web-push rejects the key or subject", async () => {
    mocks.setVapidDetails.mockImplementation(() => {
      throw new Error("Vapid subject is not a valid URL");
    });
    const result = await sendPush({ title: "x" });
    expect(result).toMatchObject({ ok: false, code: "not_configured" });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("prunes a subscription the push service says is gone (404 or 410) and keeps the rest", async () => {
    mocks.sendNotification.mockImplementation((sub: { endpoint: string }) =>
      sub.endpoint.endsWith("/a") ? Promise.reject(gone(410)) : sub.endpoint.endsWith("/b") ? Promise.reject(gone(404)) : Promise.resolve({}),
    );
    expect(await sendPush({ title: "x" })).toEqual({ ok: true, sent: 1, pruned: 2, failed: 0 });
    expect(deleted).toEqual([["a", "b"]]);
  });

  it("keeps a subscription on any other failure and counts it, without logging the endpoint", async () => {
    mocks.sendNotification.mockRejectedValue(gone(500));
    expect(await sendPush({ title: "x" })).toEqual({ ok: true, sent: 0, pruned: 0, failed: 3 });
    expect(deleted).toEqual([]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("push.example");
  });

  it("sends nothing when there are no subscriptions", async () => {
    mocks.createAdminClient.mockReturnValue(db([]));
    expect(await sendPush({ title: "x" })).toEqual({ ok: true, sent: 0, pruned: 0, failed: 0 });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("reports a database failure as internal", async () => {
    mocks.createAdminClient.mockReturnValue(db([], { message: "boom" }));
    expect(await sendPush({ title: "x" })).toEqual({ ok: false, code: "internal", message: "Something went wrong" });
  });

  it.each([
    [{ title: "  " }],
    [{ title: "x", url: "https://evil.example" }],
    [{ title: "x", url: "//evil.example" }],
    [{ title: "x", body: "y".repeat(4000) }],
  ])("refuses a bad payload %j before it touches the database", async (payload) => {
    expect(await sendPush(payload)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });
});
