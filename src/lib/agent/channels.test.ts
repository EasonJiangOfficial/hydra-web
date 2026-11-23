// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendPush = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/push/send", () => ({ sendPush }));

const { liveChannels, pushChannel } = await import("./channels");
const { deliver } = await import("./deliver");
const { memoryStore } = await import("./testing");

beforeEach(() => {
  vi.unstubAllEnvs();
  sendPush.mockReset();
});

const vapid = () => {
  vi.stubEnv("VAPID_PUBLIC_KEY", "pub");
  vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
  vi.stubEnv("VAPID_SUBJECT", "mailto:owner@example.test");
};

describe("agent delivery channels", () => {
  it("leaves push out until VAPID is set, so deliver records not_configured", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "");
    expect(liveChannels()).toEqual({});
    const status = await deliver(memoryStore().store, { kind: "reminder", title: "Call the bank", dedupe_key: "r1", channels: ["notification", "push"] }, liveChannels());
    expect(status).toEqual({ notification: "stored", push: "not_configured" });
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("sends a reminder to the phone with its link", async () => {
    vapid();
    sendPush.mockResolvedValue({ ok: true, sent: 1, pruned: 0, failed: 0 });
    const status = await deliver(
      memoryStore().store,
      { kind: "reminder", title: "Call the bank", href: "/planning?task=abc", dedupe_key: "r2", channels: ["push"] },
      liveChannels(),
    );
    expect(status).toEqual({ push: "sent" });
    expect(sendPush).toHaveBeenCalledWith(expect.objectContaining({ title: "Call the bank", url: "/planning?task=abc" }));
  });

  it("cuts a long routine output to fit a push, and a failed send is recorded as failed", async () => {
    sendPush.mockResolvedValue({ ok: false, code: "internal", message: "x" });
    await expect(pushChannel({ id: "n1", title: "Digest", body: "a".repeat(4000), href: null })).rejects.toThrow("push internal");
    const sent = sendPush.mock.calls[0][0] as { body: string; url: string; tag: string };
    expect(sent.body.length).toBe(600);
    expect(sent).toMatchObject({ url: "/", tag: "n1" });
  });
});
