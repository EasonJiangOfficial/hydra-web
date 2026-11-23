/* Browser speech-to-text (Web Speech API). Where it is missing the card falls back to a typed input. */

import { isIOS } from "./audio";

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onaudiostart?: (() => void) | null;
  onspeechstart?: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

/**
 * The swap point for speech-to-text: anything that starts and stops and calls these handlers. Today the browser's
 * recognizer; a recorder that sends audio to a server route could stand in on iOS, where WebKit's recognizer can go
 * deaf after an <audio> element plays (WebKit bug 321436), with no change to the controller.
 */
export type Listener = { start(): void; stop(): void };
export type ListenerHandlers = {
  onInterim(text: string): void;
  onFinal(text: string): void;
  /** The browser refused the microphone or the recognizer, or (iOS) it hears nothing ("no-result"): typed input only from here. */
  onFatal(reason: string): void;
  /**
   * The recognizer picked up speech (it may still give no words). iOS rarely sends speechstart: there it also means
   * a session captured audio for CAUGHT_MS with no words yet.
   */
  onSpeech?(): void;
  /** False while a quiet session is expected (Hydra is thinking): it then never counts toward DEAF_SESSIONS. */
  expecting?(): boolean;
};

/**
 * iOS: this many recognizer sessions in a row that end without a word and the listener stops, instead of restarting
 * forever. iOS sends audiostart but never soundstart, so a session counts when it never got audiostart, or captured
 * for DEAF_MS and still gave no words (a deaf recognizer, WebKit 321436); only while words are expected.
 */
export const DEAF_SESSIONS = 2;
/** iOS: this many wordless sessions in a row stop it too, however short each was (a deaf recognizer whose sessions end fast). */
export const DEAF_ANY_SESSIONS = 4;
/** iOS: a session that captured this long with no words counts toward DEAF_SESSIONS. */
export const DEAF_MS = 3000;
/** iOS: a session that captured this long with no words heard him and missed it (a tap-off says so); a quicker tap is silent. */
export const CAUGHT_MS = 1200;
/** iOS: interim words that stop changing this long are the utterance (some iOS builds never send isFinal). */
export const STALL_MS = 1500;
/** 250 ms between one utterance's session and the next. */
const RESTART_MS = 250;
const FATAL = new Set(["not-allowed", "service-not-allowed", "audio-capture", "network"]);

export function speechSupported(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return typeof (w.SpeechRecognition ?? w.webkitSpeechRecognition) === "function";
}

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/** Null when the browser has no recognizer. Restarts itself after each utterance until stop(). */
export function createListener(h: ListenerHandlers): Listener | null {
  if (!speechSupported()) return null;
  const w = window as unknown as Record<string, new () => Recognition>;
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  const ios = isIOS();
  let rec: Recognition | null = null;
  let on = false;
  let misses = 0;
  /** Wordless sessions in a row of any length (misses counts only the long or audio-less ones). */
  let quiet = 0;
  let restart: ReturnType<typeof setTimeout> | undefined;
  let stall: ReturnType<typeof setTimeout> | undefined;

  const begin = () => {
    if (!on) return;
    // A start while the page is hidden is refused (not-allowed): start again once it shows.
    if (hidden()) return void document.addEventListener("visibilitychange", begin, { once: true });
    const r = new Ctor();
    rec = r;
    let heard = false;
    let audio = false;
    /** iOS: it captured for DEAF_MS. */
    let long = false;
    let caught: ReturnType<typeof setTimeout> | undefined;
    let deaf: ReturnType<typeof setTimeout> | undefined;
    let last = "";
    /** Its words went out already (STALL_MS): what it says after that is dropped. */
    let sent = false;
    const send = () => {
      clearTimeout(stall);
      if (sent || !last) return;
      sent = true;
      h.onFinal(last);
    };
    r.continuous = false;
    r.interimResults = true;
    r.lang = "en-US";
    r.onaudiostart = () => {
      audio = true;
      if (!ios) return;
      caught = setTimeout(() => {
        if (rec === r && !heard) h.onSpeech?.();
      }, CAUGHT_MS);
      deaf = setTimeout(() => (long = true), DEAF_MS);
    };
    r.onspeechstart = () => {
      if (rec === r) h.onSpeech?.();
    };
    r.onresult = (e) => {
      if (rec !== r || sent) return;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript.trim();
        if (!text) continue;
        heard = true;
        if (e.results[i].isFinal) {
          clearTimeout(stall);
          last = "";
          h.onFinal(text);
        } else if (text !== last) {
          last = text;
          h.onInterim(text);
          if (ios) {
            clearTimeout(stall);
            stall = setTimeout(() => {
              if (rec !== r) return;
              send();
              try {
                r.stop();
              } catch {}
            }, STALL_MS);
          }
        }
      }
    };
    r.onerror = (e) => {
      if (rec !== r) return;
      // no-speech and aborted are routine; a denied microphone is not, unless the page was hidden (it starts again on show).
      if (FATAL.has(e.error) && !(e.error === "not-allowed" && hidden())) {
        on = false;
        h.onFatal(e.error);
      }
    };
    r.onend = () => {
      if (rec !== r) return;
      if (ios) send(); // a session that ended on interim words without a final: they were the utterance
      clearTimeout(stall);
      clearTimeout(caught);
      clearTimeout(deaf);
      if (!on) return;
      if (heard) misses = quiet = 0;
      else if (ios && !hidden() && (h.expecting?.() ?? true)) {
        if (!audio || long) misses++;
        if (misses >= DEAF_SESSIONS || ++quiet >= DEAF_ANY_SESSIONS) {
          on = false;
          return h.onFatal("no-result");
        }
      }
      restart = setTimeout(begin, RESTART_MS);
    };
    try {
      r.start();
    } catch {
      /* already started */
    }
  };

  return {
    start() {
      if (on) return;
      on = true;
      misses = quiet = 0;
      begin();
    },
    stop() {
      on = false;
      clearTimeout(restart);
      clearTimeout(stall);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", begin);
      const r = rec;
      rec = null;
      try {
        r?.abort();
      } catch {
        /* already stopped */
      }
    },
  };
}
