// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 0220: /api/agent/avatars (owner session only) and the avatar in /api/agent/state (owner or a paired device). */
const m = vi.hoisted(() => ({
  isOwner: true,
  devices: new Map<string, { id: string; scopes: string[] }>(),
  forwardAsOwner: vi.fn(async (_req: Request, deviceId: string) => Response.json({ forwarded: deviceId })),
  mem: null as null | ReturnType<typeof import("@/lib/agent/testing").memoryStore>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({ rpc: async (name: string) => (name === "is_owner" ? { data: m.isOwner, error: null } : { data: null, error: null }) }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, string>) => {
      if (name === "agent_device_auth") {
        const d = m.devices.get(args.p_key_hash);
        return { data: d ? [d] : [], error: null };
      }
      return { data: 0, error: null };
    },
  }),
}));
vi.mock("@/lib/agent/bridge", () => ({ forwardAsOwner: m.forwardAsOwner }));
vi.mock("@/lib/agent/store", async (orig) => ({ ...(await orig<object>()), supabaseStore: () => m.mem!.store }));

const avatars = await import("./route");
const state = await import("../state/route");
const { memoryStore } = await import("@/lib/agent/testing");
const { sha256, KEY_PREFIX } = await import("@/lib/agent/devices");

const URL_ = "https://hydra.example/api/agent/avatars";
const send = (method: string, body?: unknown, headers: Record<string, string> = {}, url = URL_) =>
  new Request(url, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const VOICE = "0123456789abcdef0123456789abcdef";
const KEY = `${KEY_PREFIX}desktop-key`;

beforeEach(() => {
  vi.clearAllMocks();
  m.isOwner = true;
  m.devices.clear();
  m.mem = memoryStore();
});

describe("/api/agent/avatars", () => {
  it("adds, lists, edits and deletes an avatar", async () => {
    const res = await avatars.POST(send("POST", { name: " Tony ", voiceId: VOICE.toUpperCase(), curse: true }));
    expect(res.status).toBe(201);
    const { avatar } = await res.json();
    expect(avatar).toMatchObject({ name: "Tony", voiceId: VOICE, curse: true, slang: false, styleNotes: "" });
    expect((await (await avatars.GET(send("GET"))).json()).avatars).toEqual([avatar]);

    const edited = await avatars.PATCH(send("PATCH", { id: avatar.id, slang: true, styleNotes: "  Brooklyn.  " }));
    expect((await edited.json()).avatar).toMatchObject({ slang: true, styleNotes: "Brooklyn." });

    const del = await avatars.DELETE(send("DELETE", undefined, {}, `${URL_}?id=${avatar.id}`));
    expect(await del.json()).toEqual({ ok: true, activityId: null });
    expect(await m.mem!.store.listAvatars()).toEqual([]);
    expect((await avatars.DELETE(send("DELETE", undefined, {}, `${URL_}?id=${avatar.id}`))).status).toBe(404);
    expect((await avatars.PATCH(send("PATCH", { id: avatar.id, name: "X" }))).status).toBe(404);
  });

  it("refuses anything invalid with 400 and writes nothing", async () => {
    const bad = [
      {},
      { name: "Tony" },
      { name: "", voiceId: VOICE },
      { name: "x".repeat(41), voiceId: VOICE },
      { name: "Tony", voiceId: "a1b2c3d4" },
      { name: "Tony", voiceId: VOICE, styleNotes: "x".repeat(1001) },
      { name: "Tony", voiceId: VOICE, curse: "yes" },
      { name: "Tony", voiceId: VOICE, id: "00000000-0000-4000-8000-000000000001" },
    ];
    for (const b of bad) expect([b, (await avatars.POST(send("POST", b))).status]).toEqual([b, 400]);
    expect((await avatars.POST(new Request(URL_, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }))).status).toBe(400);
    expect((await avatars.PATCH(send("PATCH", { id: "not-a-uuid", name: "X" }))).status).toBe(400);
    expect((await avatars.DELETE(send("DELETE", undefined, {}, `${URL_}?id=nope`))).status).toBe(400);
    expect(await m.mem!.store.listAvatars()).toEqual([]);
  });

  it("is the owner session only: a paired device and a stranger get 401 for every method", async () => {
    m.isOwner = false;
    m.devices.set(sha256(KEY), { id: "00000000-0000-4000-8000-0000000000d1", scopes: ["agent", "relay"] });
    for (const headers of [{}, { authorization: `Bearer ${KEY}` }] as Record<string, string>[]) {
      expect((await avatars.GET(send("GET", undefined, headers))).status).toBe(401);
      expect((await avatars.POST(send("POST", { name: "Tony", voiceId: VOICE }, headers))).status).toBe(401);
      expect((await avatars.PATCH(send("PATCH", { id: "00000000-0000-4000-8000-000000000001", name: "X" }, headers))).status).toBe(401);
      expect((await avatars.DELETE(send("DELETE", undefined, headers, `${URL_}?id=00000000-0000-4000-8000-000000000001`))).status).toBe(401);
    }
    expect(m.forwardAsOwner).not.toHaveBeenCalled();
    expect(await m.mem!.store.listAvatars()).toEqual([]);
  });
});

describe("the active avatar in /api/agent/state", () => {
  const STATE = "https://hydra.example/api/agent/state";
  it("GET answers activeAvatar and the quick-switch list; PATCH activeAvatarId switches and answers it", async () => {
    const tony = await m.mem!.store.createAvatar({ name: "Tony", voiceId: VOICE, curse: true, slang: true, styleNotes: "Brooklyn." });
    let body = await (await state.GET(new Request(STATE))).json();
    expect(body.activeAvatar).toBeNull();
    expect(body.settings.activeAvatarId).toBeNull();
    expect(body.avatars).toEqual([{ id: tony.id, name: "Tony" }]);

    const res = await state.PATCH(send("PATCH", { activeAvatarId: tony.id }, {}, STATE));
    expect(await res.json()).toMatchObject({ ok: true, settings: { activeAvatarId: tony.id }, activeAvatar: tony });
    body = await (await state.GET(new Request(STATE))).json();
    expect(body.activeAvatar).toEqual({ id: tony.id, name: "Tony", voiceId: VOICE, curse: true, slang: true, styleNotes: "Brooklyn." });

    expect(await (await state.PATCH(send("PATCH", { activeAvatarId: null }, {}, STATE))).json()).toMatchObject({ settings: { activeAvatarId: null }, activeAvatar: null });
  });

  it("an avatar that does not exist, or not a uuid, is 400 and changes nothing", async () => {
    expect((await state.PATCH(send("PATCH", { activeAvatarId: "00000000-0000-4000-8000-0000000000ff" }, {}, STATE))).status).toBe(400);
    expect((await state.PATCH(send("PATCH", { activeAvatarId: "Tony" }, {}, STATE))).status).toBe(400);
    expect((await m.mem!.store.settings()).activeAvatar).toBeNull();
  });

  it("a paired device (scope agent) reads and switches it through the owner bridge", async () => {
    m.isOwner = false;
    m.devices.set(sha256(KEY), { id: "00000000-0000-4000-8000-0000000000d1", scopes: ["agent"] });
    const res = await state.GET(new Request(STATE, { headers: { authorization: `Bearer ${KEY}` } }));
    expect(await res.json()).toEqual({ forwarded: "00000000-0000-4000-8000-0000000000d1" });
  });
});
