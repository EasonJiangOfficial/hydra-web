import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAUGHT_MS, DEAF_MS, DEAF_SESSIONS, STALL_MS, createListener, type ListenerHandlers, DEAF_ANY_SESSIONS } from "./listener";

/* The browser recognizer behind the Listener seam, with the iPhone's ways of failing: no final, deaf sessions, a hidden page. */

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1";

/** One recognizer session: its handlers, and how it was ended. */
class FakeRec {
  static all: FakeRec[] = [];
  continuous = true;
  interimResults = false;
  lang = "";
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onaudiostart: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  started = false;
  stopped = false;
  aborted = false;
  constructor() {
    FakeRec.all.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  abort() {
    this.aborted = true;
  }
  /** The recognizer heard `text` (final or not). */
  say(text: string, isFinal = false) {
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] });
  }
  end() {
    this.onend?.();
  }
  /** iOS: capture started. iOS sends this, and never soundstart, and rarely speechstart. */
  audio() {
    this.onaudiostart?.();
  }
}

const last = () => FakeRec.all.at(-1)!;
function handlers() {
  return { onInterim: vi.fn(), onFinal: vi.fn(), onFatal: vi.fn() } satisfies ListenerHandlers;
}
const iPhone = () => vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE);

beforeEach(() => {
  FakeRec.all = [];
  vi.useFakeTimers();
  vi.stubGlobal("webkitSpeechRecognition", FakeRec);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("listener", () => {
  it("iOS: interim words that stop changing for STALL_MS are the utterance (no isFinal ever comes); its late final is dropped", async () => {
    iPhone();
    const h = handlers();
    createListener(h)!.start();
    last().say("what is");
    await vi.advanceTimersByTimeAsync(STALL_MS - 200);
    last().say("what is my balance"); // still changing: the wait starts again
    last().say("what is my balance"); // the same words repeated: not a change
    await vi.advanceTimersByTimeAsync(STALL_MS - 1);
    expect(h.onFinal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.onFinal.mock.calls).toEqual([["what is my balance"]]);
    const rec = last();
    expect(rec.stopped).toBe(true); // the session ends; a new one listens after it
    rec.say("what is my balance", true);
    expect(h.onFinal).toHaveBeenCalledTimes(1);
    rec.end();
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeRec.all).toHaveLength(2);
  });

  it("iOS: a session that ends on interim words without a final sends them", () => {
    iPhone();
    const h = handlers();
    createListener(h)!.start();
    last().say("pay rent");
    last().end();
    expect(h.onFinal.mock.calls).toEqual([["pay rent"]]);
  });

  it("a final still goes at once, once, everywhere", async () => {
    for (const ios of [true, false]) {
      if (ios) iPhone();
      else vi.restoreAllMocks();
      const h = handlers();
      createListener(h)!.start();
      last().say("hello");
      last().say("hello there", true);
      await vi.advanceTimersByTimeAsync(STALL_MS * 2);
      last().end();
      expect(h.onFinal.mock.calls).toEqual([["hello there"]]);
    }
  });

  it(`iOS: ${DEAF_SESSIONS} sessions in a row that end with no words stop the restart loop with "no-result"`, async () => {
    iPhone();
    const h = handlers();
    createListener(h)!.start();
    last().end(); // deaf (WebKit 321436): it started, it heard nothing
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeRec.all).toHaveLength(2);
    last().end();
    expect(h.onFatal.mock.calls).toEqual([["no-result"]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeRec.all).toHaveLength(2); // no more restarts every 250 ms
  });

  it(`iOS (audiostart and end only): a session that captured for DEAF_MS with no words counts as deaf; ${DEAF_SESSIONS} in a row stop it`, async () => {
    iPhone();
    const h = handlers();
    createListener(h)!.start();
    for (let i = 0; i < DEAF_SESSIONS; i++) {
      if (i) await vi.advanceTimersByTimeAsync(300);
      last().audio();
      await vi.advanceTimersByTimeAsync(DEAF_MS);
      last().end();
    }
    expect(h.onFatal.mock.calls).toEqual([["no-result"]]);
  });

  it("iOS (audiostart and end only): a session that captured briefly, or one while words are not expected (thinking), never counts as deaf", async () => {
    iPhone();
    const h = handlers();
    createListener(h)!.start();
    for (let i = 0; i < 3; i++) {
      last().audio(); // a quiet owner, a session iOS ends early: it captured, but not for DEAF_MS
      await vi.advanceTimersByTimeAsync(DEAF_MS - 1);
      last().end();
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(h.onFatal).not.toHaveBeenCalled();
    let expecting = false;
    const t = { ...handlers(), expecting: () => expecting };
    createListener(t)!.start();
    for (let i = 0; i < 3; i++) {
      last().end(); // Hydra is thinking: he is quiet
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(t.onFatal).not.toHaveBeenCalled();
    expecting = true; // the reply ended: now a deaf recognizer is caught again
    last().end();
    await vi.advanceTimersByTimeAsync(300);
    last().end();
    expect(t.onFatal.mock.calls).toEqual([["no-result"]]);
  });

  it("iOS: a deaf recognizer whose sessions end fast still stops after DEAF_ANY_SESSIONS wordless sessions", async () => {
    iPhone();
    const h = handlers();
    createListener(h)!.start();
    for (let i = 0; i < DEAF_ANY_SESSIONS; i++) {
      last().audio();
      await vi.advanceTimersByTimeAsync(2500); // shorter than DEAF_MS: aborted early, as WebKit does
      last().end();
      if (i < DEAF_ANY_SESSIONS - 1) {
        expect(h.onFatal).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(300);
      }
    }
    expect(h.onFatal.mock.calls).toEqual([["no-result"]]);
  });

  it("iOS (audiostart and end only): capturing CAUGHT_MS with no words reports speech; a quicker session, or words, do not", async () => {
    iPhone();
    const h = { ...handlers(), onSpeech: vi.fn() };
    createListener(h)!.start();
    last().audio();
    await vi.advanceTimersByTimeAsync(CAUGHT_MS - 1);
    expect(h.onSpeech).not.toHaveBeenCalled(); // a quick tap right after it started stays silent
    await vi.advanceTimersByTimeAsync(1);
    expect(h.onSpeech).toHaveBeenCalledTimes(1);
    last().end();
    await vi.advanceTimersByTimeAsync(300);
    last().audio();
    await vi.advanceTimersByTimeAsync(CAUGHT_MS / 2);
    last().end(); // the session ended early: it did not capture CAUGHT_MS
    await vi.advanceTimersByTimeAsync(CAUGHT_MS);
    last().audio();
    last().say("hi"); // words came: nothing was missed
    await vi.advanceTimersByTimeAsync(CAUGHT_MS);
    expect(h.onSpeech).toHaveBeenCalledTimes(1);
  });

  it("off iOS audiostart reports nothing: only speechstart does (desktop unchanged)", async () => {
    const h = { ...handlers(), onSpeech: vi.fn() };
    createListener(h)!.start();
    last().audio();
    await vi.advanceTimersByTimeAsync(DEAF_MS * 2);
    expect(h.onSpeech).not.toHaveBeenCalled();
  });

  it("speech the recognizer picks up is reported, even when it gives no words", () => {
    const h = { ...handlers(), onSpeech: vi.fn() };
    createListener(h)!.start();
    last().onspeechstart?.();
    expect(h.onSpeech).toHaveBeenCalledTimes(1);
  });

  it("iOS: a session with words resets the count; off iOS silence restarts forever (no-speech is routine there)", async () => {
    iPhone();
    const h = handlers();
    createListener(h)!.start();
    last().end();
    await vi.advanceTimersByTimeAsync(300);
    last().say("hi", true);
    last().end();
    await vi.advanceTimersByTimeAsync(300);
    last().end();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.onFatal).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const desk = handlers();
    createListener(desk)!.start();
    for (let i = 0; i < 5; i++) {
      last().end();
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(desk.onFatal).not.toHaveBeenCalled();
  });

  it("a not-allowed while the page is hidden is not fatal: it starts again when the page shows", async () => {
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const h = handlers();
    createListener(h)!.start();
    vis.mockReturnValue("hidden"); // the Home Screen app went to the background
    last().onerror?.({ error: "not-allowed" });
    last().end();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.onFatal).not.toHaveBeenCalled();
    expect(FakeRec.all).toHaveLength(1); // no start while hidden
    vis.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeRec.all).toHaveLength(2);
    expect(last().started).toBe(true);
    last().onerror?.({ error: "not-allowed" }); // refused while showing: that is the owner's answer
    expect(h.onFatal.mock.calls).toEqual([["not-allowed"]]);
  });

  it("after stop(), a session's late words are dropped", () => {
    const h = handlers();
    const l = createListener(h)!;
    l.start();
    const rec = last();
    l.stop();
    expect(rec.aborted).toBe(true);
    rec.say("late", true);
    rec.end();
    expect(h.onFinal).not.toHaveBeenCalled();
    expect(FakeRec.all).toHaveLength(1);
  });
});
