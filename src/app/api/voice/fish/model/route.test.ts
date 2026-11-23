// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** GET /api/voice/fish/model: Fish's GET /model/{id} is mocked; nothing reaches the network. */
const mocks = vi.hoisted(() => ({ owner: true, fetch: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createServerClient: async () => ({ rpc: async () => ({ data: mocks.owner, error: null }) }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/agent/bridge", () => ({ forwardAsOwner: vi.fn() }));

const { GET } = await import("./route");
const ID = "0123456789abcdef0123456789abcdef";
const get = (id: string | null, headers: Record<string, string> = {}) =>
  GET(new Request(`https://hydra.example/api/voice/fish/model${id === null ? "" : `?id=${encodeURIComponent(id)}`}`, { headers }));
const MODEL = {
  _id: ID,
  type: "tts",
  title: "Tony from Brooklyn",
  languages: ["en", "it"],
  state: "trained",
  samples: [{ title: "hi", text: "hi", task_id: "t", audio: "https://cdn.fish.audio/samples/tony.mp3" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.owner = true;
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubEnv("FISH_AUDIO_API_KEY", "fish-test-key");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /api/voice/fish/model", () => {
  it("asks Fish with the server key and answers the title, the sample and the languages", async () => {
    mocks.fetch.mockResolvedValue(Response.json(MODEL));
    const res = await get(` ${ID.toUpperCase()} `);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID, title: "Tony from Brooklyn", sampleUrl: "https://cdn.fish.audio/samples/tony.mp3", languages: ["en", "it"] });
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toBe(`https://api.fish.audio/model/${ID}`);
    expect(init.headers.authorization).toBe("Bearer fish-test-key");
  });

  it("a voice without a usable sample or title still answers", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ _id: ID, title: "", samples: [{ audio: "data:audio/mp3;base64,AAAA" }] }));
    expect(await (await get(ID)).json()).toEqual({ id: ID, title: "Untitled voice", sampleUrl: null, languages: [] });
  });

  it("an id Fish does not know, or one still training: 404 unknown_voice", async () => {
    for (const status of [400, 403, 404]) {
      mocks.fetch.mockResolvedValueOnce(new Response("nope", { status }));
      const res = await get(ID);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("unknown_voice");
    }
    mocks.fetch.mockResolvedValueOnce(Response.json({ ...MODEL, state: "training" }));
    expect((await get(ID)).status).toBe(404);
  });

  it("Fish down or answering garbage: 502, and the key never leaks", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("network"));
    expect((await get(ID)).status).toBe(502);
    mocks.fetch.mockResolvedValueOnce(new Response("oops", { status: 500 }));
    const res = await get(ID);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("fish-test-key");
  });

  it("checks the id before calling Fish; 503 without the key", async () => {
    for (const bad of [null, "", "612b", "0123456789abcdef0123456789abcdeg", "../tts"]) expect((await get(bad)).status, String(bad)).toBe(400);
    vi.stubEnv("FISH_AUDIO_API_KEY", "");
    expect((await get(ID)).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("is the owner session only: a stranger or a device key gets 403 and Fish is never called", async () => {
    mocks.owner = false;
    expect((await get(ID)).status).toBe(403);
    expect((await get(ID, { authorization: "Bearer hyd_mac" })).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
