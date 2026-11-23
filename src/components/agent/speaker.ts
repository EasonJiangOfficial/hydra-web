import { Meter, audioContext, isIOS, meterElement } from "./audio";

export type SayOptions = {
  /** A filler ("Let me check."): its audio is kept for the session, and it is not part of the answer (played()). */
  filler?: boolean;
};

export type SpeakerLike = {
  say(sentence: string, opts?: SayOptions): void;
  /** Drops everything queued and silences what is playing. */
  stop(): void;
  pause(): void;
  resume(): void;
  /** 0..1 output level. */
  level(): number;
  readonly busy: boolean;
  onBusy(cb: (busy: boolean) => void): void;
  /** The answer sentences that started playing since the last stop() (fillers left out): where a barge-in cut it off. */
  played?(): string[];
  /** Fetches a filler's audio ahead of time, so it starts at once when it is needed. */
  prefetch?(text: string): void;
  /** Sound is coming out right now (busy also covers a sentence still downloading). */
  audible?(): boolean;
  /** Call inside a tap or click: lets iPhone Safari play Hydra's voice later (see Speaker.unlock). `mic` (default true): the recognizer is on. */
  unlock?(mic?: boolean): void;
  /** The output spectrum (BAND_COUNT values 0..1) into `out`; false while nothing plays. */
  bands?(out: Float32Array): boolean;
  /** The voice changed (another avatar, 0220): drop the filler audio kept in the old voice. */
  forget?(): void;
};

/**
 * A voice-like spectrum when there is no analyser (speechSynthesis): energy in the low and middle bands, each band
 * flickering at its own rate, scaled by the level, so the orb still spikes unevenly.
 */
export function syntheticBands(out: Float32Array, t: number, level: number) {
  const n = out.length;
  for (let b = 0; b < n; b++) {
    const x = b / (n - 1);
    const shape = Math.exp(-((x - 0.28) ** 2) / 0.05) + 0.45 * Math.exp(-((x - 0.62) ** 2) / 0.02);
    const flicker = 0.5 + 0.5 * Math.sin(t * (5.3 + b * 1.7) + b * 2.39) * Math.sin(t * (2.1 + (b % 5)) + b);
    out[b] = Math.min(1, (0.25 + level) * shape * (0.3 + flicker));
  }
}

/** The TTS route has no voice set up (503 voice_not_configured): the only failure that ends Fish for the session. */
class NoVoice extends Error {}

/** Sentences fetched ahead of the one playing, so the next one is ready when this one ends (no gap). */
export const LOOKAHEAD = 2;

type Item = { text: string; filler: boolean; blob?: Promise<Blob> };

/**
 * 50 ms of silence (a WAV, base64): played once inside a tap so iPhone Safari lets this element play later sentences.
 * Played as a blob: URL, because Hydra's CSP (media-src 'self' blob:) refuses a data: URL.
 */
const SILENT_WAV = "UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

/**
 * Hydra's voice. Each sentence goes to POST /api/voice/tts (Fish Audio, the owner's voice model) as soon as it is
 * queued, up to LOOKAHEAD ahead of the one playing, and they play in order through one <audio> element that a Web
 * Audio analyser watches. A sentence whose Fish audio fails (a 502, a 429, a network error, bad audio) is said by the
 * browser's speechSynthesis, with a synthetic level, and the next sentence tries Fish again. Only 503
 * voice_not_configured hands the rest of the session to the browser voice.
 * ponytail: each sentence downloads whole before it plays (a blob URL); MediaSource streaming would start the first
 * sentence sooner, but iOS Safari has no MediaSource for audio/mpeg. Add it if first-sentence latency shows.
 */
export class Speaker implements SpeakerLike {
  private queue: Item[] = [];
  private running = false;
  private audio: HTMLAudioElement | null = null;
  private meter: Meter | null = null;
  private ac = new AbortController();
  private synth = false;
  private synthSpeaking = false;
  private paused = false;
  private playing = false;
  private unlocked = false;
  private silent: string | null = null;
  private gen = 0;
  private started: string[] = [];
  /** Filler audio, kept for the session: the same eight lines repeat. */
  private cache = new Map<string, Promise<Blob>>();
  private cb: (busy: boolean) => void = () => {};

  constructor(private fetchFn: typeof fetch = (...a) => fetch(...a)) {}

  get busy() {
    return this.running || this.queue.length > 0;
  }
  onBusy(cb: (busy: boolean) => void) {
    this.cb = cb;
  }
  played() {
    return [...this.started];
  }
  forget() {
    this.cache.clear();
  }
  audible() {
    return !this.paused && (this.playing || this.synthSpeaking);
  }

  /**
   * Owner: "i dont think audio from agent works on web app on phone". iPhone Safari only starts sound from a tap: a
   * new <audio> made after the network wait cannot play, and speechSynthesis needs a first tap too. Called
   * synchronously inside the tap or Send: resume the context, make the one element and play silence on it.
   * navigator.audioSession stays "auto": "playback" stops iOS from opening the microphone at all (the recognizer
   * hears nothing), and a playing <audio> element already sounds with the silent switch on.
   */
  unlock(mic = true) {
    if (typeof window === "undefined") return;
    audioContext();
    const el = this.element();
    // On iOS 27 a speak() in the same tap mutes the microphone (WebKit 218815): prime it only when the browser voice is
    // the voice or no recognizer listens. Known gap: with the mic on and Fish the voice, the first fallback to the
    // browser voice after a Fish error can be silent on iOS (it is outside any tap).
    if (this.synth || !mic) {
      try {
        const synth = window.speechSynthesis;
        if (synth && !synth.speaking) {
          const u = new SpeechSynthesisUtterance(" ");
          u.volume = 0;
          synth.speak(u);
        }
      } catch {}
    }
    if (this.unlocked) return;
    this.unlocked = true;
    if (!el.src || el.ended || el.paused) {
      this.silent ??= URL.createObjectURL(new Blob([Uint8Array.from(atob(SILENT_WAV), (c) => c.charCodeAt(0))], { type: "audio/wav" }));
      el.src = this.silent;
      void el.play().catch(() => {
        this.unlocked = false;
      });
    }
  }

  /**
   * The one <audio> element. Off iOS a Web Audio analyser meters it on its way out. On iOS it plays straight out:
   * through Web Audio it is silent whenever the context is not running (interrupted after a call or the lock screen),
   * and the orb draws syntheticBands instead.
   */
  private element(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      if (!isIOS()) this.meter = meterElement(this.audio);
    }
    return this.audio;
  }

  say(sentence: string, opts: SayOptions = {}) {
    this.queue.push({ text: sentence, filler: opts.filler === true });
    this.pump();
    if (!this.running) void this.run();
  }

  prefetch(text: string) {
    if (this.synth || this.cache.has(text)) return;
    this.cached(text);
  }

  stop() {
    this.gen++;
    this.queue = [];
    this.started = [];
    this.ac.abort();
    this.ac = new AbortController();
    // speechSynthesis stays paused across cancel(): the next reply would never sound.
    if (this.paused) window.speechSynthesis?.resume();
    this.paused = false;
    this.audio?.pause();
    this.playing = false;
    if (this.synthSpeaking) window.speechSynthesis?.cancel();
    this.synthSpeaking = false;
    if (this.running) {
      this.running = false;
      this.cb(false);
    }
  }

  pause() {
    this.paused = true;
    this.audio?.pause();
    if (this.synthSpeaking) window.speechSynthesis?.pause();
  }
  resume() {
    this.paused = false;
    if (this.audio?.src && !this.audio.ended) void this.audio.play().catch(() => {});
    if (this.synthSpeaking) window.speechSynthesis?.resume();
  }

  level(): number {
    if (this.paused || !this.running) return 0;
    if (this.synthSpeaking || !this.meter) {
      const t = performance.now() / 1000;
      return 0.38 + 0.2 * Math.sin(t * 9) + 0.12 * Math.sin(t * 23.7);
    }
    return this.meter.read();
  }

  /** The voice's spectrum for the orb (BAND_COUNT values 0..1). The browser voice has no audio graph: a voice-like stand-in. */
  bands(out: Float32Array): boolean {
    if (this.paused || !this.running) return false;
    if (this.synthSpeaking || !this.meter) {
      syntheticBands(out, performance.now() / 1000, this.level());
      return true;
    }
    return this.meter.bands(out);
  }

  /** Starts the audio requests for the next LOOKAHEAD sentences. */
  private pump() {
    if (this.synth) return;
    for (const it of this.queue.slice(0, LOOKAHEAD)) it.blob ??= it.filler ? this.cached(it.text) : this.tts(it.text, this.ac.signal);
  }

  private cached(text: string): Promise<Blob> {
    let p = this.cache.get(text);
    if (!p) {
      // Not tied to stop(): a filler cut off now is still the right audio next time.
      p = this.tts(text);
      p.catch(() => this.cache.delete(text));
      this.cache.set(text, p);
    }
    return p;
  }

  private tts(text: string, signal?: AbortSignal): Promise<Blob> {
    const p = (async () => {
      const res = await this.fetchFn("/api/voice/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal });
      if (!res.ok) {
        const body: unknown = res.status === 503 ? await res.json().catch(() => null) : null;
        const none = !!body && typeof body === "object" && (body as { error?: unknown }).error === "voice_not_configured";
        throw none ? new NoVoice("voice_not_configured") : new Error(`tts ${res.status}`);
      }
      return res.blob();
    })();
    p.catch(() => {}); // awaited by run(); a dropped one must not surface as unhandled
    return p;
  }

  private async run() {
    const gen = ++this.gen;
    this.running = true;
    this.cb(true);
    while (this.queue.length && gen === this.gen) {
      const it = this.queue.shift()!;
      this.pump();
      try {
        if (this.synth) await this.speakSynth(it, gen);
        else await this.speakFish(it, gen);
      } catch (e) {
        this.playing = false;
        if (gen !== this.gen) return;
        // No voice set up: the browser voice for the session. Anything else: for this sentence only.
        if (e instanceof NoVoice) this.synth = true;
        await this.speakSynth(it, gen).catch(() => {});
      }
    }
    if (gen === this.gen) {
      this.running = false;
      this.cb(false);
    }
  }

  private async speakFish(it: Item, gen: number) {
    const blob = await (it.blob ?? this.tts(it.text, this.ac.signal));
    if (gen !== this.gen) return;
    const audio = this.element();
    const url = URL.createObjectURL(blob);
    audio.src = url;
    if (!it.filler) this.started.push(it.text);
    try {
      await new Promise<void>((resolve, reject) => {
        audio.onplaying = () => void (this.playing = true);
        audio.onended = () => {
          this.playing = false;
          resolve();
        };
        audio.onerror = () => reject(new Error("audio"));
        // A stop() mid-sentence pauses the element; poll the generation so the loop can move on.
        const watch = setInterval(() => gen !== this.gen && (clearInterval(watch), resolve()), 120);
        audio.addEventListener("ended", () => clearInterval(watch), { once: true });
        audio.addEventListener("error", () => clearInterval(watch), { once: true });
        // Paused while it downloaded: resume() starts it.
        if (!this.paused) audio.play().catch(reject);
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private speakSynth(it: Item, gen: number) {
    return new Promise<void>((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth || gen !== this.gen) return resolve();
      const u = new SpeechSynthesisUtterance(it.text);
      this.synthSpeaking = true;
      if (!it.filler) this.started.push(it.text);
      const done = () => {
        clearTimeout(cap);
        this.synthSpeaking = false;
        resolve();
      };
      // Some browsers drop an utterance silently (no voices, headless): never wait longer than the text could take.
      const cap = setTimeout(done, 1500 + it.text.length * 100);
      u.onend = done;
      u.onerror = done;
      synth.speak(u);
    });
  }
}
