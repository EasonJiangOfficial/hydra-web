import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOOKAHEAD, Speaker } from "./speaker";

/* Hydra's Fish voice: sentences fetched ahead, played in order with no gap, the browser voice only when the route fails. */

const log: string[] = [];
class FakeAudio extends EventTarget {
  src = "";
  ended = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play() {
    log.push(`play ${this.src}`);
    this.ended = false;
    setTimeout(() => {
      this.ended = true;
      this.onended?.();
      this.dispatchEvent(new Event("ended"));
    }, 100);
    return Promise.resolve();
  }
  pause() {}
}

let blobs = 0;
beforeEach(() => {
  log.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("Audio", FakeAudio);
  // The blob URL names the sentence, so the log shows what played.
  vi.spyOn(URL, "createObjectURL").mockImplementation((b) => (b as Blob & { said?: string }).said ?? `blob${++blobs}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A TTS route: each sentence answers after `ms`, with a blob that names it. */
function route(ms = 50, status = 200) {
  const fn = vi.fn<typeof fetch>(async (_u, init) => {
    const text = JSON.parse(String(init?.body)).text as string;
    log.push(`fetch ${text}`);
    await new Promise((r) => setTimeout(r, ms));
    if (status !== 200) return Response.json({ error: "voice_not_configured" }, { status });
    const blob = Object.assign(new Blob(["mp3"]), { said: text });
    return { ok: true, blob: async () => blob } as unknown as Response;
  });
  return fn;
}

const synth = () => {
  const s = { speak: vi.fn((u: { onend?: () => void }) => setTimeout(() => u.onend?.(), 10)), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn() };
  vi.stubGlobal("speechSynthesis", s);
  vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(public text: string) {} });
  return s;
};

describe("Speaker", () => {
  it("fetches up to LOOKAHEAD sentences ahead and plays them in order, the next one the moment the last ends", async () => {
    const s = synth();
    const sp = new Speaker(route(50));
    sp.say("One.");
    sp.say("Two.");
    sp.say("Three.");
    sp.say("Four.");
    await vi.advanceTimersByTimeAsync(0);
    // One is playing as soon as it is fetched; Two and Three are already on the way.
    expect(log.filter((l) => l.startsWith("fetch"))).toEqual(["fetch One.", "fetch Two.", "fetch Three."].slice(0, 1 + LOOKAHEAD));
    await vi.advanceTimersByTimeAsync(50);
    expect(log.at(-1)).toBe("play One.");
    await vi.advanceTimersByTimeAsync(100); // One ends: Two was ready, it plays at once
    expect(log.slice(-2)).toEqual(["fetch Four.", "play Two."]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(log.filter((l) => l.startsWith("play"))).toEqual(["play One.", "play Two.", "play Three.", "play Four."]);
    expect(sp.played()).toEqual(["One.", "Two.", "Three.", "Four."]);
    expect(sp.busy).toBe(false);
    expect(s.speak).not.toHaveBeenCalled(); // Fish worked: the browser voice never spoke
  });

  it("the browser voice takes over only when the route fails", async () => {
    const s = synth();
    const sp = new Speaker(route(10, 503));
    sp.say("Hello.");
    sp.say("Again.");
    await vi.advanceTimersByTimeAsync(500);
    expect(s.speak.mock.calls.map((c) => (c[0] as unknown as { text: string }).text)).toEqual(["Hello.", "Again."]);
    expect(log.some((l) => l.startsWith("play"))).toBe(false);
  });

  it("F9: one Fish failure (a 502) falls back for that sentence only; the next one is Fish again", async () => {
    const s = synth();
    let n = 0;
    const ok = route(10);
    const fetchFn = vi.fn<typeof fetch>(async (u, init) => (++n === 1 ? Response.json({ error: "tts_failed" }, { status: 502 }) : ok(u, init)));
    const sp = new Speaker(fetchFn);
    sp.say("Hello.");
    sp.say("Again.");
    await vi.advanceTimersByTimeAsync(500);
    sp.say("Third.");
    await vi.advanceTimersByTimeAsync(500);
    expect(s.speak.mock.calls.map((c) => (c[0] as unknown as { text: string }).text)).toEqual(["Hello."]);
    expect(log.filter((l) => l.startsWith("play"))).toEqual(["play Again.", "play Third."]);
  });

  it("paused while a sentence downloads, it stays quiet until resume; audible only while sound plays", async () => {
    synth();
    const sp = new Speaker(route(50));
    sp.say("Hello.");
    sp.pause();
    await vi.advanceTimersByTimeAsync(80);
    expect(log.some((l) => l.startsWith("play"))).toBe(false);
    expect(sp.audible()).toBe(false);
    sp.resume();
    expect(log.at(-1)).toBe("play Hello.");
  });

  it("stop drops the queue and what played; fillers keep their audio for the session and are not part of the answer", async () => {
    synth();
    const fetchFn = route(10);
    const sp = new Speaker(fetchFn);
    sp.prefetch("Let me check.");
    await vi.advanceTimersByTimeAsync(20);
    sp.say("Let me check.", { filler: true });
    sp.say("Your balance is $40.");
    await vi.advanceTimersByTimeAsync(300);
    expect(sp.played()).toEqual(["Your balance is $40."]);
    sp.stop();
    expect(sp.played()).toEqual([]);
    sp.say("Let me check.", { filler: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchFn.mock.calls.filter((c) => String(c[1]?.body).includes("Let me check"))).toHaveLength(1);
  });
});

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1";

/** A Web Audio context that records what was asked of it. */
function fakeContext(state: string) {
  const calls = { sources: 0, resumes: 0 };
  class Ctx {
    state = state;
    destination = {};
    resume() {
      calls.resumes++;
      return Promise.resolve();
    }
    createMediaElementSource() {
      calls.sources++;
      throw new Error("not in this test"); // meterElement gives up: no meter either way
    }
  }
  vi.stubGlobal("AudioContext", Ctx);
  return calls;
}

describe("Speaker on the phone (mobile voice fixes)", () => {
  it("C1: unlock leaves navigator.audioSession at auto, so iOS still opens the microphone", () => {
    const session = { type: "auto" };
    Object.defineProperty(navigator, "audioSession", { value: session, configurable: true });
    try {
      new Speaker(route()).unlock();
      expect(session.type).toBe("auto");
    } finally {
      delete (navigator as unknown as Record<string, unknown>).audioSession;
    }
  });

  it("C9: the unlock's silent clip plays from one blob: URL (the CSP's media-src allows blob:, not data:)", () => {
    synth();
    const sp = new Speaker(route());
    sp.unlock();
    const play = log.find((l) => l.startsWith("play "));
    expect(play).toMatch(/^play blob/);
    const made = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(made.type).toBe("audio/wav");
    expect(made.size).toBeGreaterThan(44); // a WAV header and its silence
  });

  it("C7: speechSynthesis is primed in the tap only once the browser voice is the voice", async () => {
    const s = synth();
    const primes = () => s.speak.mock.calls.filter((c) => (c[0] as unknown as { text: string }).text === " ").length;
    const fish = new Speaker(route(10));
    fish.unlock();
    fish.unlock();
    expect(primes()).toBe(0); // Fish is the voice: no speak() beside the mic opening
    const browser = new Speaker(route(10, 503));
    browser.say("Hello."); // 503 voice_not_configured: the browser voice for the session
    await vi.advanceTimersByTimeAsync(200);
    browser.unlock();
    expect(primes()).toBe(1);
    fish.unlock(false); // no recognizer holds the mic (typing): primed, so a fallback to the browser voice can sound
    expect(primes()).toBe(2);
  });

  it("C6: on iOS the voice plays straight out of the <audio> element (no Web Audio source), and the orb gets voice-like bands", async () => {
    vi.resetModules();
    const calls = fakeContext("running");
    const { Speaker: Fresh } = await import("./speaker");
    new Fresh(route(10)).unlock(); // a desktop browser meters the element
    expect(calls.sources).toBe(1);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE);
    synth();
    const sp = new Fresh(route(10));
    sp.unlock();
    sp.say("Hello.");
    await vi.advanceTimersByTimeAsync(20); // fetched and playing
    expect(log.at(-1)).toBe("play Hello.");
    expect(calls.sources).toBe(1); // none made on the iPhone
    const out = new Float32Array(24);
    expect(sp.bands(out)).toBe(true);
    expect(Math.max(...out)).toBeGreaterThan(0);
  });

  it("C6: audioContext() resumes an interrupted context too (a call or the lock screen on iOS), not only a suspended one", async () => {
    vi.resetModules();
    const calls = fakeContext("interrupted");
    const { audioContext } = await import("./audio");
    audioContext();
    expect(calls.resumes).toBe(1);
  });
});
