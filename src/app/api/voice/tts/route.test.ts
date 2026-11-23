// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  fetch: vi.fn(),
  devices: new Map<string, { id: string; scopes: string[] }>(),
  rateHits: [] as string[],
  /** agent_settings as readSettings sees it (0220: the active avatar embedded); null: no row; an Error: the read fails. */
  settings: null as Record<string, unknown> | null | Error,
}));
/** agent_settings through either client: from().select().maybeSingle(). */
const from = () => ({
  select: () => ({
    maybeSingle: async () => (mocks.settings instanceof Error ? { data: null, error: { message: mocks.settings.message } } : { data: mocks.settings, error: null }),
  }),
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createServerClient: async () => ({ rpc: mocks.rpc, from }) }));
vi.mock("@/lib/agent/bridge", () => ({ forwardAsOwner: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, string>) => {
      if (name === "agent_device_auth") {
        const d = mocks.devices.get(args.p_key_hash);
        return { data: d ? [d] : [], error: null };
      }
      if (name === "agent_rate_hit") mocks.rateHits.push(args.p_bucket);
      return { data: 0, error: null };
    },
    from,
  }),
}));

const { POST, fishReferenceId } = await import("./route");
const TEST_VOICE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const { sha256 } = await import("@/lib/agent/devices");

const req = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  new Request("https://hydra.example/api/voice/tts", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.devices.clear();
  mocks.rateHits.length = 0;
  mocks.settings = null;
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubEnv("FISH_AUDIO_API_KEY", "fish-test-key");
  vi.stubEnv("FISH_DEFAULT_VOICE_ID", TEST_VOICE_ID);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/voice/tts", () => {
  it("streams Fish Audio's mp3 with the owner's voice and the server-only key", async () => {
    mocks.fetch.mockResolvedValue(new Response("mp3-bytes", { status: 200 }));
    const res = await POST(req({ text: "  Hello, sir.  " }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(await res.text()).toBe("mp3-bytes");
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe("https://api.fish.audio/v1/tts");
    expect(init.headers.authorization).toBe("Bearer fish-test-key");
    expect(init.headers.model).toBe("s2.1-pro-free"); // the free API model: the owner's free plan has no API balance
    expect(JSON.parse(init.body)).toMatchObject({ text: "Hello, sir.", reference_id: fishReferenceId(), format: "mp3" });
    expect(fishReferenceId()).toBe(TEST_VOICE_ID);
  });

  it("uses a placeholder voice when FISH_DEFAULT_VOICE_ID is missing or not 32 hex characters", async () => {
    for (const value of ["", "not-a-voice", "abcd1234"]) {
      vi.stubEnv("FISH_DEFAULT_VOICE_ID", value);
      mocks.fetch.mockResolvedValue(new Response("mp3", { status: 200 }));
      expect((await POST(req({ text: "Hi" }))).status).toBe(200);
      expect(JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body).reference_id).toBe("00000000000000000000000000000000");
      mocks.fetch.mockClear();
    }
  });

  it("answers 503 voice_not_configured without the key, so the client uses the browser voice", async () => {
    vi.stubEnv("FISH_AUDIO_API_KEY", "");
    const res = await POST(req({ text: "Hi" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "voice_not_configured" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("is owner only, and spends nothing for anyone else", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    expect((await POST(req({ text: "Hi" }))).status).toBe(403);
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "no session" } });
    expect((await POST(req({ text: "Hi" }))).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    expect((await POST(req({ text: "Hi" }, { "content-type": "text/plain" }))).status).toBe(415);
    for (const body of ["not json", {}, { text: "" }, { text: "   " }, { text: 5 }, { text: "x".repeat(1001) }]) {
      expect((await POST(req(body))).status).toBe(400);
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("reports an upstream failure as 502 and never leaks the key", async () => {
    mocks.fetch.mockResolvedValue(new Response("nope", { status: 401 }));
    const res = await POST(req({ text: "Hi" }));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("fish-test-key");
    mocks.fetch.mockRejectedValue(new Error("network"));
    expect((await POST(req({ text: "Hi" }))).status).toBe(502);
  });

  it("lets Hydra Desktop speak with its device key (scope agent), rate limited", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null }); // no owner session on the Mac's call
    mocks.fetch.mockResolvedValue(new Response("mp3-bytes", { status: 200 }));
    mocks.devices.set(sha256("hyd_mac"), { id: "00000000-0000-4000-8000-0000000000d1", scopes: ["agent", "mcp", "relay"] });
    const res = await POST(req({ text: "Hi" }, { "content-type": "application/json", authorization: "Bearer hyd_mac" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("mp3-bytes");
    expect(mocks.rateHits).toEqual(["device:00000000-0000-4000-8000-0000000000d1:agent"]);
  });

  it("refuses a device key without the agent scope, and an unknown key, before spending anything", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    mocks.devices.set(sha256("hyd_mcp"), { id: "00000000-0000-4000-8000-0000000000d2", scopes: ["mcp"] });
    expect((await POST(req({ text: "Hi" }, { "content-type": "application/json", authorization: "Bearer hyd_mcp" }))).status).toBe(403);
    expect((await POST(req({ text: "Hi" }, { "content-type": "application/json", authorization: "Bearer hyd_unknown" }))).status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  describe("0220: the voice is the active avatar's", () => {
    const TONY = "0123456789abcdef0123456789abcdef";
    const PREVIEW = "fedcba9876543210fedcba9876543210";
    const withAvatar = (voice: string) => ({
      model: "claude-opus-5-5", effort_live: "low", effort_routine: "medium", sleep_word: "Hydra, sleep", wake_phrase: "Hey Hydra", clap_sensitivity: "medium", brain: "mac", approve_all: false,
      agent_avatars: { id: "00000000-0000-4000-8000-00000000a7a1", name: "Tony", fish_voice_id: voice, curse: true, slang: false, style_notes: "" },
    });
    const sentVoices = () => mocks.fetch.mock.calls.map(([, init]) => JSON.parse(init.body).reference_id);
    const mac = { "content-type": "application/json", authorization: "Bearer hyd_mac" };

    it("the owner's browser speaks with the active avatar's voice", async () => {
      mocks.settings = withAvatar(TONY);
      mocks.fetch.mockResolvedValue(new Response("mp3", { status: 200 }));
      expect((await POST(req({ text: "Hi" }))).status).toBe(200);
      expect(sentVoices()).toEqual([TONY]);
    });

    it("the paired Mac speaks with it too, with no change on the Mac (its request is still just {text})", async () => {
      mocks.rpc.mockResolvedValue({ data: false, error: null });
      mocks.devices.set(sha256("hyd_mac"), { id: "00000000-0000-4000-8000-0000000000d1", scopes: ["agent"] });
      mocks.settings = withAvatar(TONY);
      mocks.fetch.mockResolvedValue(new Response("mp3", { status: 200 }));
      expect((await POST(req({ text: "Hi" }, mac))).status).toBe(200);
      expect(sentVoices()).toEqual([TONY]);
    });

    it("no avatar, no settings row, or a settings read that fails: Hydra's own voice", async () => {
      mocks.fetch.mockResolvedValue(new Response("mp3", { status: 200 }));
      mocks.settings = { ...withAvatar(TONY), agent_avatars: null };
      await POST(req({ text: "Hi" }));
      mocks.settings = null;
      await POST(req({ text: "Hi" }));
      mocks.settings = new Error("relation agent_avatars does not exist");
      await POST(req({ text: "Hi" }));
      expect(sentVoices()).toEqual([fishReferenceId(), fishReferenceId(), fishReferenceId()]);
    });

    it("Fish refusing the avatar's voice says the sentence once more in Hydra's own voice", async () => {
      mocks.settings = withAvatar(TONY);
      mocks.fetch.mockResolvedValueOnce(new Response("no such model", { status: 404 })).mockResolvedValueOnce(new Response("mp3", { status: 200 }));
      const res = await POST(req({ text: "Hi" }));
      expect(res.status).toBe(200);
      expect(sentVoices()).toEqual([TONY, fishReferenceId()]);
      // 403 (a private voice of another account) is a bad voice too, the same rule as GET /api/voice/fish/model.
      mocks.fetch.mockReset().mockResolvedValueOnce(new Response("forbidden", { status: 403 })).mockResolvedValueOnce(new Response("mp3", { status: 200 }));
      expect((await POST(req({ text: "Hi" }))).status).toBe(200);
      expect(sentVoices()).toEqual([TONY, fishReferenceId()]);
      // Both failing: 502, and the client uses its own voice for that sentence.
      mocks.fetch.mockReset().mockResolvedValue(new Response("nope", { status: 400 }));
      expect((await POST(req({ text: "Hi" }))).status).toBe(502);
    });

    it("a key or account fault (401, 402) is not retried in another voice", async () => {
      mocks.settings = withAvatar(TONY);
      for (const status of [401, 402]) {
        mocks.fetch.mockReset().mockResolvedValue(new Response("nope", { status }));
        expect((await POST(req({ text: "Hi" }))).status).toBe(502);
        expect(sentVoices()).toEqual([TONY]);
      }
    });

    it("the owner previews any voice with `voice`, never retried in another one", async () => {
      mocks.settings = withAvatar(TONY);
      mocks.fetch.mockResolvedValue(new Response("mp3", { status: 200 }));
      expect((await POST(req({ text: "Hey, it's Tony.", voice: PREVIEW }))).status).toBe(200);
      expect(sentVoices()).toEqual([PREVIEW]);
      mocks.fetch.mockReset().mockResolvedValue(new Response("no such model", { status: 404 }));
      expect((await POST(req({ text: "Hi", voice: PREVIEW }))).status).toBe(502);
      expect(sentVoices()).toEqual([PREVIEW]);
    });

    it("refuses a preview voice from a paired device, and a malformed one, before spending anything", async () => {
      expect((await POST(req({ text: "Hi", voice: "612b" }))).status).toBe(400);
      expect((await POST(req({ text: "Hi", voice: 5 }))).status).toBe(400);
      mocks.rpc.mockResolvedValue({ data: false, error: null });
      mocks.devices.set(sha256("hyd_mac"), { id: "00000000-0000-4000-8000-0000000000d1", scopes: ["agent"] });
      const res = await POST(req({ text: "Hi", voice: PREVIEW }, mac));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "owner_only" });
      expect(mocks.fetch).not.toHaveBeenCalled();
    });
  });
  describe("Fish busy: deadline, one retry", () => {
    const TONY = "0123456789abcdef0123456789abcdef";
    const models = () => mocks.fetch.mock.calls.map(([, init]) => init.headers.model);
    const voices = () => mocks.fetch.mock.calls.map(([, init]) => JSON.parse(init.body).reference_id);
    const status = (s: number) => new Response("x", { status: s });
    /** Fish hangs until the attempt's signal aborts. */
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    /** Runs POST to completion under fake timers. */
    const run = async (r: Request) => {
      const pending = POST(r);
      await vi.advanceTimersByTimeAsync(30_000);
      return pending;
    };
    let log: MockInstance<typeof console.error>;
    beforeEach(() => {
      vi.useFakeTimers();
      log = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.useRealTimers();
      log.mockRestore();
    });

    it("503 then 200: the quick retry on the free model says it", async () => {
      mocks.fetch.mockResolvedValueOnce(status(503)).mockResolvedValueOnce(new Response("mp3", { status: 200 }));
      const res = await run(req({ text: "Hello there" }));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("mp3");
      expect(models()).toEqual(["s2.1-pro-free", "s2.1-pro-free"]);
    });

    it("waits ~250 ms after a 5xx and ~600 ms after a 429 before the retry", async () => {
      mocks.fetch.mockResolvedValueOnce(status(503)).mockResolvedValue(new Response("mp3", { status: 200 }));
      let pending = POST(req({ text: "Hi" }));
      await vi.advanceTimersByTimeAsync(249);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).status).toBe(200);
      expect(mocks.fetch).toHaveBeenCalledTimes(2);

      mocks.fetch.mockReset().mockResolvedValueOnce(status(429)).mockResolvedValue(new Response("mp3", { status: 200 }));
      pending = POST(req({ text: "Hi" }));
      await vi.advanceTimersByTimeAsync(599);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).status).toBe(200);
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });

    it("503 twice: 502 after exactly 2 calls, both on the free model", async () => {
      mocks.fetch.mockResolvedValue(status(503));
      expect((await run(req({ text: "Hi" }))).status).toBe(502);
      expect(models()).toEqual(["s2.1-pro-free", "s2.1-pro-free"]);
    });

    it("Fish hanging past 6 s: that attempt is aborted and retried", async () => {
      mocks.fetch.mockImplementationOnce(hang).mockResolvedValueOnce(new Response("mp3", { status: 200 }));
      const pending = POST(req({ text: "Hi" }));
      await vi.advanceTimersByTimeAsync(5_999);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      expect((mocks.fetch.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((mocks.fetch.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(250);
      expect((await pending).status).toBe(200);
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
      expect(log.mock.calls.flat().join("\n")).toContain("deadline (model s2.1-pro-free, attempt 1)");
    });

    it("hangs every time: gives up within the 13 s sentence budget, well before the Mac's 20 s timeout", async () => {
      mocks.fetch.mockImplementation(hang);
      let pending = POST(req({ text: "Hi" }));
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(12_250); // 6 s + 250 ms + 6 s, then no third try
      expect(settled).toBe(true);
      expect((await pending).status).toBe(502);
      expect(models()).toEqual(["s2.1-pro-free", "s2.1-pro-free"]);
      expect(log.mock.calls.flat().join("\n")).toContain("deadline (model s2.1-pro-free, attempt 2)");

      // A bad avatar voice first, then Hydra's voice hanging: still inside the budget.
      mocks.settings = { agent_avatars: { id: "00000000-0000-4000-8000-00000000a7a1", name: "Tony", fish_voice_id: TONY, curse: true, slang: false, style_notes: "" } };
      mocks.fetch.mockReset().mockResolvedValueOnce(status(404)).mockImplementation(hang);
      pending = POST(req({ text: "Hi" }));
      settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(13_000);
      expect(settled).toBe(true);
      expect((await pending).status).toBe(502);
      expect(mocks.fetch).toHaveBeenCalledTimes(3);
    });

    it("401, 402 and 403 are never retried", async () => {
      for (const s of [401, 402, 403]) {
        mocks.fetch.mockReset().mockResolvedValue(status(s));
        expect((await run(req({ text: "Hi" }))).status).toBe(502);
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
      }
      expect(log.mock.calls.flat().join("\n")).toContain("402 on the free model: check the model header");
    });

    it("an avatar's bad voice still falls back to Hydra's voice, and composes with the busy retry in at most 3 calls", async () => {
      mocks.settings = { agent_avatars: { id: "00000000-0000-4000-8000-00000000a7a1", name: "Tony", fish_voice_id: TONY, curse: true, slang: false, style_notes: "" } };
      mocks.fetch.mockResolvedValueOnce(status(404)).mockResolvedValueOnce(new Response("mp3", { status: 200 }));
      expect((await run(req({ text: "Hi" }))).status).toBe(200);
      expect(voices()).toEqual([TONY, fishReferenceId()]);

      mocks.fetch.mockReset().mockResolvedValueOnce(status(404)).mockResolvedValue(status(503));
      expect((await run(req({ text: "Hi" }))).status).toBe(502);
      expect(voices()).toEqual([TONY, fishReferenceId(), fishReferenceId()]);
      expect(models()).toEqual(["s2.1-pro-free", "s2.1-pro-free", "s2.1-pro-free"]);

      // Busy first, then a bad voice, then busy again: still never more than 3.
      mocks.fetch.mockReset().mockResolvedValueOnce(status(503)).mockResolvedValueOnce(status(404)).mockResolvedValue(status(503));
      expect((await run(req({ text: "Hi" }))).status).toBe(502);
      expect(mocks.fetch.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it("never more than 3 calls, whatever Fish answers, all on the free model", async () => {
      mocks.settings = { agent_avatars: { id: "00000000-0000-4000-8000-00000000a7a1", name: "Tony", fish_voice_id: TONY, curse: true, slang: false, style_notes: "" } };
      const answers = [404, 503, 429, 500, 403, 400, 422, 502];
      for (let seed = 0; seed < 40; seed++) {
        mocks.fetch.mockReset().mockImplementation(async () => status(answers[(seed * 7 + mocks.fetch.mock.calls.length * 3) % answers.length]));
        await run(req({ text: "Hi" }));
        expect(mocks.fetch.mock.calls.length).toBeLessThanOrEqual(3);
        expect(models().every((m) => m === "s2.1-pro-free")).toBe(true);
      }
    });

    it("a client abort stops at once: no further Fish calls", async () => {
      const ctl = new AbortController();
      const aborting = (signal: AbortSignal) =>
        new Request("https://hydra.example/api/voice/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hi" }), signal });
      mocks.fetch.mockImplementation(hang);
      const pending = POST(aborting(ctl.signal));
      await vi.advanceTimersByTimeAsync(1_000);
      ctl.abort();
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await pending).status).toBe(499);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);

      // Aborted while waiting for the retry: the retry never goes out.
      const ctl2 = new AbortController();
      mocks.fetch.mockReset().mockResolvedValue(status(503));
      const pending2 = POST(aborting(ctl2.signal));
      await vi.advanceTimersByTimeAsync(100);
      ctl2.abort();
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await pending2).status).toBe(499);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });

    it("each failure logs one line with status and attempt, never the key or the text", async () => {
      mocks.fetch.mockResolvedValue(status(503));
      await run(req({ text: "a secret sentence" }));
      const lines = log.mock.calls.map((c) => c.join(" "));
      expect(lines).toEqual([
        "[voice] Fish Audio answered 503 (model s2.1-pro-free, attempt 1)",
        "[voice] Fish Audio answered 503 (model s2.1-pro-free, attempt 2)",
      ]);
      expect(lines.join()).not.toContain("fish-test-key");
      expect(lines.join()).not.toContain("secret sentence");
    });
  });
});
