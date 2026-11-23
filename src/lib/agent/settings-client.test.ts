import { describe, expect, it, vi } from "vitest";

import { AGENT_DEFAULTS, getAgentSettings, modelKeysClient, patchAgentSettings, readAgentSettings, readProviders } from "./settings-client";

/** A mocked /api/agent/state that keeps the contract: GET returns settings, PATCH any subset, 400 on invalid. */
function route(initial: Record<string, unknown> = { sleepWord: "Hydra, sleep", brain: "mac" }) {
  let settings = { ...initial };
  const calls: { method: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("/api/agent/state");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, body });
    if (method === "PATCH") {
      if (body.wakePhrase === "x") return Response.json({ error: "invalid_input" }, { status: 400 });
      settings = { ...settings, ...body };
      return Response.json({ ok: true, settings });
    }
    return Response.json({ threads: [], settings });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("agent settings client", () => {
  it("GET reads the valid fields; the page lays them over the defaults", async () => {
    const { fetchImpl } = route({ sleepWord: "Night Hydra", brain: "mac", model: "claude-haiku-5-5", effortLive: "turbo" });
    const r = await getAgentSettings(fetchImpl);
    expect(r).toEqual({ ok: true, settings: { sleepWord: "Night Hydra", model: "claude-haiku-5-5" } });
    expect({ ...AGENT_DEFAULTS, ...(r.ok ? r.settings : {}) }).toMatchObject({ effortLive: "low", wakePhrase: "Hey Hydra", clapSensitivity: "medium" });
  });

  it("PATCH sends only the fields given and returns the server's settings", async () => {
    const { fetchImpl, calls } = route();
    const r = await patchAgentSettings({ wakePhrase: "  Okay Hydra ", clapSensitivity: "high" }, fetchImpl);
    expect(calls.at(-1)).toEqual({ method: "PATCH", body: { wakePhrase: "Okay Hydra", clapSensitivity: "high" } });
    expect(r).toEqual({ ok: true, settings: { sleepWord: "Hydra, sleep", wakePhrase: "Okay Hydra", clapSensitivity: "high" } });
  });

  it.each([{ wakePhrase: "a" }, { wakePhrase: "x".repeat(41) }, { sleepWord: "x".repeat(61) }, { model: "gpt-9" }, { effortRoutine: "off" }, { brain: "server" }])(
    "a value outside the contract is refused before sending: %o",
    async (patch) => {
      const { fetchImpl } = route();
      expect((await patchAgentSettings(patch as never, fetchImpl)).ok).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("0200: approve all goes through as a boolean, and only as one", async () => {
    const { fetchImpl, calls } = route();
    expect(await patchAgentSettings({ approveAll: true }, fetchImpl)).toEqual({ ok: true, settings: { sleepWord: "Hydra, sleep", approveAll: true } });
    expect(calls.at(-1)).toEqual({ method: "PATCH", body: { approveAll: true } });
    expect((await patchAgentSettings({ approveAll: "yes" } as never, fetchImpl)).ok).toBe(false);
    expect(readAgentSettings({ approveAll: 1 })).toEqual({});
    expect(AGENT_DEFAULTS.approveAll).toBe(false);
  });

  it("0220: the active avatar goes through as a uuid or null, and is kept on read", async () => {
    const { fetchImpl, calls } = route();
    const id = "00000000-0000-4000-8000-00000000a7a1";
    expect((await patchAgentSettings({ activeAvatarId: id }, fetchImpl)).ok).toBe(true);
    expect(calls.at(-1)).toEqual({ method: "PATCH", body: { activeAvatarId: id } });
    expect((await patchAgentSettings({ activeAvatarId: null }, fetchImpl)).ok).toBe(true);
    expect((await patchAgentSettings({ activeAvatarId: "Tony" } as never, fetchImpl)).ok).toBe(false);
    expect(readAgentSettings({ activeAvatarId: id })).toEqual({ activeAvatarId: id });
    expect(readAgentSettings({ activeAvatarId: null })).toEqual({ activeAvatarId: null });
    expect(AGENT_DEFAULTS.activeAvatarId).toBeNull();
  });

  it("a 400, a 401 and a network failure come back as messages", async () => {
    const bad = vi.fn(async () => Response.json({ error: "invalid_input" }, { status: 400 })) as unknown as typeof fetch;
    expect(await patchAgentSettings({ model: "claude-opus-5-5" }, bad)).toEqual({ ok: false, message: "Not saved: check the value" });
    const out = vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 })) as unknown as typeof fetch;
    expect(await getAgentSettings(out)).toEqual({ ok: false, message: "Sign in as the owner" });
    const down = vi.fn(async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await getAgentSettings(down)).toMatchObject({ ok: false });
  });

  it("readAgentSettings drops unknown keys and bad values", () => {
    expect(readAgentSettings({ model: "claude-sonnet-5-5", effortLive: "turbo", extra: 1 })).toEqual({ model: "claude-sonnet-5-5" });
    // models.ts: every catalog model and every level low..max pass (the server checks a level against its model).
    expect(readAgentSettings({ model: "grok-4.7", effortLive: "xhigh", effortRoutine: "max" })).toEqual({ model: "grok-4.7", effortLive: "xhigh", effortRoutine: "max" });
    expect(readAgentSettings(null)).toEqual({});
  });
});

describe("models (0225)", () => {
  it("GET answers the connected providers in catalog order, Claude always; a 409 or effort refusal says what to do", async () => {
    const get = vi.fn(async () => Response.json({ settings: {}, providers: ["xai", "bogus", "openai"] })) as unknown as typeof fetch;
    expect(await getAgentSettings(get)).toEqual({ ok: true, settings: {}, providers: ["anthropic", "openai", "xai"] });
    expect(readProviders(undefined)).toEqual(["anthropic"]);
    const notConnected = vi.fn(async () => Response.json({ error: "model_not_connected", message: "Connect Grok in Settings, Agent first." }, { status: 409 })) as unknown as typeof fetch;
    expect(await patchAgentSettings({ model: "grok-4.7" }, notConnected)).toEqual({ ok: false, message: "Connect Grok in Settings, Agent first." });
    const notOffered = vi.fn(async () => Response.json({ error: "effort_not_offered", message: "Grok 4.7 goes up to X-High" }, { status: 400 })) as unknown as typeof fetch;
    expect(await patchAgentSettings({ effortLive: "max" }, notOffered)).toEqual({ ok: false, message: "Grok 4.7 goes up to X-High" });
  });

  it("the keys client checks a key before sending, PUTs {provider, key}, and DELETE answers the settings it moved", async () => {
    const calls: { method: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("/api/agent/models/keys");
      const method = init?.method ?? "GET";
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "PUT") return Response.json({ key: { provider: "xai", hint: "4f2a", updatedAt: "2026-11-22T00:00:00Z" } });
      if (method === "DELETE") return Response.json({ ok: true, settings: { model: "claude-opus-5-5", effortLive: "xhigh" } });
      return Response.json({ keys: [{ provider: "xai", hint: "4f2a", updatedAt: "2026-11-22T00:00:00Z" }, { provider: "nope" }] });
    }) as unknown as typeof fetch;
    const keys = modelKeysClient(fetchImpl);
    expect(await keys.list()).toEqual({ ok: true, data: [{ provider: "xai", hint: "4f2a", updatedAt: "2026-11-22T00:00:00Z" }] });
    for (const bad of ["short", "xai-has a space in it 000000", "x".repeat(401)]) expect((await keys.connect("xai", bad)).ok).toBe(false);
    expect(calls).toHaveLength(1);
    const key = "xai-test-key-demo-4f2a";
    expect(await keys.connect("xai", `  ${key} `)).toEqual({ ok: true, data: { provider: "xai", hint: "4f2a", updatedAt: "2026-11-22T00:00:00Z" } });
    expect(calls.at(-1)).toEqual({ method: "PUT", body: { provider: "xai", key } });
    expect(await keys.remove("xai")).toEqual({ ok: true, data: { model: "claude-opus-5-5", effortLive: "xhigh" } });
    expect(calls.at(-1)).toEqual({ method: "DELETE", body: { provider: "xai" } });
    const refused = vi.fn(async () => Response.json({ error: "key_refused", message: "xAI refused this key" }, { status: 400 })) as unknown as typeof fetch;
    expect(await modelKeysClient(refused).connect("xai", key)).toEqual({ ok: false, message: "xAI refused this key" });
  });
});
