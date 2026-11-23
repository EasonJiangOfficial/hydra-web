// @vitest-environment node
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 0225: /api/agent/models/keys (owner session only; the key is checked with xAI's free model list, mocked here: no
 * provider is called) and /api/agent/relay/keys/[provider] (paired devices with the relay scope only).
 */
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

const keys = await import("./route");
const relayKey = await import("../../relay/keys/[provider]/route");
const { memoryStore } = await import("@/lib/agent/testing");
const { sha256, KEY_PREFIX } = await import("@/lib/agent/devices");

const URL_ = "https://hydra.example/api/agent/models/keys";
const send = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const XAI_KEY = "xai-TESTKEY0123456789abcdef4f2a";
const DEVICE = `${KEY_PREFIX}mac-key`;
const DEVICE_ID = "00000000-0000-4000-8000-0000000000d1";
const deviceGet = (provider: string, headers: Record<string, string> = { authorization: `Bearer ${DEVICE}` }) =>
  relayKey.GET(new Request(`https://hydra.example/api/agent/relay/keys/${provider}`, { headers }), { params: Promise.resolve({ provider }) });

/** xAI's GET /v1/models, mocked. */
const xai = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.clearAllMocks();
  m.isOwner = true;
  m.devices.clear();
  m.mem = memoryStore();
  vi.stubEnv("HYDRA_TOKEN_KEY", randomBytes(32).toString("base64"));
  xai.mockResolvedValue(Response.json({ object: "list", data: [{ id: "grok-4.7", object: "model" }, { id: "grok-3-mini" }] }));
  vi.stubGlobal("fetch", xai);
});

describe("PUT /api/agent/models/keys", () => {
  it("checks the key with xAI's model list, stores it sealed ('v1.'), and never answers or lists the key", async () => {
    const res = await keys.PUT(send("PUT", { provider: "xai", key: ` ${XAI_KEY} ` }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(XAI_KEY);
    expect(JSON.parse(text)).toEqual({ key: { provider: "xai", hint: "4f2a", updatedAt: expect.any(String) } });
    expect(xai).toHaveBeenCalledTimes(1);
    const [url, init] = xai.mock.calls[0]!;
    expect(url).toBe("https://api.x.ai/v1/models");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${XAI_KEY}`);
    const stored = m.mem!.modelKeys.get("xai")!;
    expect(stored.sealed.startsWith("v1.")).toBe(true);
    expect(stored.sealed).not.toContain(XAI_KEY);
    const list = await (await keys.GET(send("GET"))).text();
    expect(list).not.toContain(XAI_KEY);
    expect(list).not.toContain(stored.sealed);
    expect(JSON.parse(list)).toEqual({ keys: [{ provider: "xai", hint: "4f2a", updatedAt: expect.any(String) }] });
  });

  it("a key xAI refuses (401) is 400 key_refused; one with no Grok models is 400 key_no_models; xAI down is 502; nothing is stored", async () => {
    xai.mockResolvedValueOnce(Response.json({ error: "Incorrect API key provided" }, { status: 401 }));
    const refused = await keys.PUT(send("PUT", { provider: "xai", key: XAI_KEY }));
    expect([refused.status, await refused.json()]).toEqual([400, { error: "key_refused", message: "xAI refused this key" }]);
    xai.mockResolvedValueOnce(Response.json({ data: [{ id: "grok-2-vision" }] }));
    expect(await (await keys.PUT(send("PUT", { provider: "xai", key: XAI_KEY }))).json()).toMatchObject({ error: "key_no_models" });
    xai.mockResolvedValueOnce(new Response("busy", { status: 503 }));
    expect((await keys.PUT(send("PUT", { provider: "xai", key: XAI_KEY }))).status).toBe(502);
    xai.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await keys.PUT(send("PUT", { provider: "xai", key: XAI_KEY }))).status).toBe(502);
    expect(m.mem!.modelKeys.size).toBe(0);
    // A dated id counts as Grok 4.7.
    xai.mockResolvedValueOnce(Response.json({ data: [{ id: "grok-4.7-1120" }] }));
    expect((await keys.PUT(send("PUT", { provider: "xai", key: XAI_KEY }))).status).toBe(200);
  });

  it("refuses a bad body before calling xAI: no key, a short key, spaces, an unknown provider (OpenAI signs in on the Mac)", async () => {
    for (const body of [{ provider: "xai" }, { provider: "xai", key: "short" }, { provider: "xai", key: "xai has spaces 0123456789" }, { provider: "openai", key: XAI_KEY }]) {
      expect([body, (await keys.PUT(send("PUT", body))).status]).toEqual([body, 400]);
    }
    expect(xai).not.toHaveBeenCalled();
  });

  it("owner browser session only: a paired device is refused (403 forwarded, 401 with its own key), and so is no session", async () => {
    const asDevice = { "x-hydra-device": DEVICE_ID };
    expect((await keys.PUT(send("PUT", { provider: "xai", key: XAI_KEY }, asDevice))).status).toBe(403);
    expect((await keys.GET(send("GET", undefined, asDevice))).status).toBe(403);
    expect((await keys.DELETE(send("DELETE", { provider: "xai" }, asDevice))).status).toBe(403);
    m.isOwner = false;
    m.devices.set(sha256(DEVICE), { id: DEVICE_ID, scopes: ["agent", "mcp", "relay"] });
    expect((await keys.PUT(send("PUT", { provider: "xai", key: XAI_KEY }, { authorization: `Bearer ${DEVICE}` }))).status).toBe(401);
    expect((await keys.GET(send("GET"))).status).toBe(401);
    expect(xai).not.toHaveBeenCalled();
    expect(m.mem!.modelKeys.size).toBe(0);
  });
});

describe("DELETE /api/agent/models/keys", () => {
  it("removes the key; Grok picked: the same request puts Opus 5.5 back, clamps the efforts, and answers the settings", async () => {
    await keys.PUT(send("PUT", { provider: "xai", key: XAI_KEY }));
    await m.mem!.store.updateSettings({ model: "grok-4.7", effortLive: "xhigh", effortRoutine: "high" });
    const res = await keys.DELETE(send("DELETE", { provider: "xai" }));
    expect(await res.json()).toEqual({ ok: true, settings: expect.objectContaining({ model: "claude-opus-5-5", effortLive: "xhigh", effortRoutine: "high" }) });
    expect(m.mem!.modelKeys.size).toBe(0);
    expect((await m.mem!.store.settings()).model).toBe("claude-opus-5-5");
    expect((await keys.DELETE(send("DELETE", { provider: "xai" }))).status).toBe(404);
  });

  it("another model picked: only the key goes", async () => {
    await keys.PUT(send("PUT", { provider: "xai", key: XAI_KEY }));
    await m.mem!.store.updateSettings({ model: "claude-haiku-5-5" });
    expect(await (await keys.DELETE(send("DELETE", { provider: "xai" }))).json()).toEqual({ ok: true });
    expect((await m.mem!.store.settings()).model).toBe("claude-haiku-5-5");
    expect((await keys.DELETE(send("DELETE", { provider: "anthropic" }))).status).toBe(400);
  });

  it("a settings write that fails keeps the key, so a retry still puts Opus back", async () => {
    await keys.PUT(send("PUT", { provider: "xai", key: XAI_KEY }));
    await m.mem!.store.updateSettings({ model: "grok-4.7" });
    const write = vi.spyOn(m.mem!.store, "updateSettings").mockRejectedValueOnce(new Error("connection reset"));
    await expect(keys.DELETE(send("DELETE", { provider: "xai" }))).rejects.toThrow("connection reset"); // Next answers 500
    expect(m.mem!.modelKeys.size).toBe(1);
    write.mockRestore();
    expect((await keys.DELETE(send("DELETE", { provider: "xai" }))).status).toBe(200);
    expect(m.mem!.modelKeys.size).toBe(0);
    expect((await m.mem!.store.settings()).model).toBe("claude-opus-5-5");
  });
});

describe("GET /api/agent/relay/keys/[provider] (relay brains)", () => {
  it("a paired device with the relay scope gets the key, no-store; 404 when there is none or the provider is unknown", async () => {
    m.devices.set(sha256(DEVICE), { id: DEVICE_ID, scopes: ["agent", "mcp", "relay"] });
    const none = await deviceGet("xai");
    expect([none.status, await none.json()]).toEqual([404, { error: "not_connected" }]);
    await keys.PUT(send("PUT", { provider: "xai", key: XAI_KEY }));
    m.isOwner = false;
    const res = await deviceGet("xai");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ key: XAI_KEY });
    expect((await deviceGet("openai")).status).toBe(404);
  });

  it("needs the relay scope; an owner browser session (no device key) gets 403; an unknown key 401", async () => {
    await keys.PUT(send("PUT", { provider: "xai", key: XAI_KEY }));
    m.devices.set(sha256(DEVICE), { id: DEVICE_ID, scopes: ["agent", "mcp"] });
    expect((await deviceGet("xai")).status).toBe(403);
    const browser = await deviceGet("xai", {});
    expect(browser.status).toBe(403);
    expect(await browser.text()).not.toContain(XAI_KEY);
    expect((await deviceGet("xai", { authorization: `Bearer ${KEY_PREFIX}unknown` })).status).toBe(401);
  });

  it("a key sealed under another HYDRA_TOKEN_KEY reads as not connected (the brain runs Claude)", async () => {
    m.devices.set(sha256(DEVICE), { id: DEVICE_ID, scopes: ["relay"] });
    await keys.PUT(send("PUT", { provider: "xai", key: XAI_KEY }));
    vi.stubEnv("HYDRA_TOKEN_KEY", randomBytes(32).toString("base64"));
    expect((await deviceGet("xai")).status).toBe(404);
  });
});
