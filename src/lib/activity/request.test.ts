// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const ssr = vi.hoisted(() => ({ createServerClient: vi.fn<(...args: unknown[]) => { kind: string }>(() => ({ kind: "client" })) }));
vi.mock("@supabase/ssr", () => ({ createServerClient: ssr.createServerClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/supabase/env", () => ({ publicEnv: () => ({ url: "http://127.0.0.1:55421", publishableKey: "pk" }) }));

const { activityHeaders, activityIdOf, tagClient, withActivity } = await import("./request");
const { createServerClient } = await import("@/lib/supabase/server");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("activity headers", () => {
  it("makes a fresh activity id per client, sent as x-hydra-activity with x-hydra-actor", () => {
    const a = activityHeaders();
    const b = activityHeaders("hydra");
    expect(a.id).toMatch(UUID);
    expect(a.id).not.toBe(b.id);
    expect(a.headers).toEqual({ "x-hydra-activity": a.id, "x-hydra-actor": "you" });
    expect(b.headers["x-hydra-actor"]).toBe("hydra");
  });

  it("reads back the id a client was tagged with, and null for any other client", () => {
    const db = tagClient({}, "a1000000-0000-4000-8000-000000000001");
    expect(activityIdOf(db)).toBe("a1000000-0000-4000-8000-000000000001");
    expect(activityIdOf({})).toBeNull();
  });

  it("adds activityId to a success only", () => {
    const db = tagClient({}, "a1000000-0000-4000-8000-000000000002");
    expect(withActivity({ ok: true, data: null }, db)).toEqual({ ok: true, data: null, activityId: "a1000000-0000-4000-8000-000000000002" });
    expect(withActivity({ ok: false, error: "x" }, db)).toEqual({ ok: false, error: "x" });
    expect(withActivity({ ok: true, data: null }, undefined)).toEqual({ ok: true, data: null });
  });

  it("createServerClient sends the headers on every client and tags the client with its id", async () => {
    const one = await createServerClient();
    const two = await createServerClient();
    const sent = ssr.createServerClient.mock.calls.map((c) => (c[2] as { global: { headers: Record<string, string> } }).global.headers);
    expect(sent).toHaveLength(2);
    expect(sent[0]["x-hydra-actor"]).toBe("you");
    expect(sent[0]["x-hydra-activity"]).toMatch(UUID);
    expect(sent[0]["x-hydra-activity"]).not.toBe(sent[1]["x-hydra-activity"]);
    expect(activityIdOf(one)).toBe(sent[0]["x-hydra-activity"]);
    expect(activityIdOf(two)).toBe(sent[1]["x-hydra-activity"]);
  });
});
