import { FALLBACKS, isEffort, type ModelFallback } from "@/lib/agent/models";
import { internalHref } from "@/lib/agent/relay-schema";
import { PANEL_PARAMS, scopeSchema, type PanelParam, type Scope, type TurnEvent, type UiEvent } from "./types";

/** Lower case, letters and digits only, single spaces: "Hydra, sleep!" -> "hydra sleep". */
export function normalizeSpoken(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** True when the transcript says the sleep word (default "Hydra, sleep"), alone or inside a sentence. */
export function hasSleepWord(transcript: string, word: string): boolean {
  const w = normalizeSpoken(word);
  return w !== "" && ` ${normalizeSpoken(transcript)} `.includes(` ${w} `);
}

/**
 * The words after the wake phrase ("Hey Hydra, and gas" -> "and gas"), or the text as it is when it does not start with
 * it. Only the phrase: "". Owner: "I should be able to interupt it if I say the start phrase".
 */
export function afterWakePhrase(text: string, phrase: string): string {
  const p = normalizeSpoken(phrase).split(" ").filter(Boolean);
  if (!p.length) return text.trim();
  const words = text.trim().split(/\s+/);
  for (let i = 0; i < p.length; i++) if (normalizeSpoken(words[i] ?? "") !== p[i]) return text.trim();
  return words.slice(p.length).join(" ").replace(/^[\s,.!?:;-]+/, "").trim();
}

const YES = new Set(["yes", "yeah", "yep", "yup", "approve", "approved", "confirm", "go ahead", "do it", "yes please"]);
const NO = new Set(["no", "nope", "nah", "decline", "declined", "cancel", "stop", "dont", "do not", "no thanks"]);

/** A whole utterance that answers a confirm prompt. Anything longer is a new request, not an answer. */
export function parseYesNo(transcript: string): "yes" | "no" | null {
  const t = normalizeSpoken(transcript.replace(/'/g, ""));
  return YES.has(t) ? "yes" : NO.has(t) ? "no" : null;
}

/**
 * Splits streamed text into whole sentences to speak; the rest waits for more text. A sentence ends at ./!/?
 * followed by whitespace, so "$4.50" stays whole and a final "." waits for the next character (or `flush`).
 */
export function takeSentences(buffer: string, flush = false): { sentences: string[]; rest: string } {
  const out: string[] = [];
  let start = 0;
  for (const m of buffer.matchAll(/[.!?]+(?=\s)|\n/g)) {
    const end = (m.index ?? 0) + m[0].length;
    const s = buffer.slice(start, end).trim();
    if (s) out.push(s);
    start = end;
  }
  const rest = buffer.slice(start);
  if (flush && rest.trim()) return { sentences: [...out, rest.trim()], rest: "" };
  return { sentences: out, rest };
}

export { stripEmotes } from "@/lib/agent/emotes";

/** What Hydra says while it works, in its own voice (owner: "let me check that" or "let me see"). */
export const FILLERS = [
  "Let me check.",
  "One sec.",
  "Let me see.",
  "Checking that now.",
  "Give me a second.",
  "Let me look.",
  "Hang on.",
  "Just a moment.",
  "Let me pull that up.",
] as const;

/** A filler, never the one said last. */
export function pickFiller(last: string | null, random: () => number = Math.random): string {
  const pool = FILLERS.filter((f) => f !== last);
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

export const wordCount = (text: string) => normalizeSpoken(text).split(" ").filter(Boolean).length;

const NUMBER_WORDS = new Set(
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion point dollars dollar cents cent".split(" "),
);
/** Share of the heard words that must be Hydra's own for it to be its echo (recognition of its voice is lossy). */
export const ECHO_SHARE = 0.7;

/**
 * True when the recognizer heard Hydra's own voice leaking back into the microphone, not the owner cutting in: most
 * heard words (ECHO_SHARE) are words Hydra just said. Numbers match loosely: Hydra writes "$3,525", the recognizer
 * hears "three thousand five hundred twenty five" (or "3525"), so any number word matches when Hydra said a number.
 */
export function isEcho(heard: string, said: string): boolean {
  const saidWords = normalizeSpoken(said).split(" ");
  const mine = new Set(saidWords);
  const saidNumber = saidWords.some((w) => /\d/.test(w));
  const words = normalizeSpoken(heard).split(" ").filter(Boolean);
  if (!words.length) return false;
  const ours = words.filter((w) => mine.has(w) || (saidNumber && (/^\d+$/.test(w) || NUMBER_WORDS.has(w)))).length;
  return ours / words.length >= ECHO_SHARE;
}

/**
 * A same-origin app path the agent may send the window to: the server's one navigate rule (internalHref in
 * relay-schema.ts), so the Mac, the server and this window refuse the same paths.
 */
export function isSafePath(href: unknown): href is string {
  return internalHref.safeParse(href).success;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Validates one event (already JSON-parsed) into a TurnEvent, or null when it is not one. The server is not trusted blindly. */
export function parseTurnEvent(v: unknown): TurnEvent | null {
  if (!isObj(v)) return null;
  switch (v.type) {
    case "thread":
      return isStr(v.threadId) && v.threadId !== "" ? { type: "thread", threadId: v.threadId } : null;
    case "turn":
      return isStr(v.turnId) && /^[0-9a-f-]{36}$/i.test(v.turnId) ? { type: "turn", turnId: v.turnId } : null;
    case "text":
      return isStr(v.delta) ? { type: "text", delta: v.delta } : null;
    case "tool":
      return isStr(v.name) && (v.status === "start" || v.status === "done" || v.status === "error")
        ? { type: "tool", name: v.name, status: v.status, summary: isStr(v.summary) ? v.summary : "" }
        : null;
    case "ui": {
      const action = parseUi(v.action);
      return action ? { type: "ui", action } : null;
    }
    case "confirm":
      return isStr(v.id) && isStr(v.summary) ? { type: "confirm", id: v.id, summary: v.summary, danger: v.danger === true } : null;
    case "model":
      return isStr(v.model) && v.model !== "" && v.model.length <= 100 && isEffort(v.effort)
        ? { type: "model", model: v.model, effort: v.effort, ...((FALLBACKS as readonly unknown[]).includes(v.fallback) ? { fallback: v.fallback as ModelFallback } : {}) }
        : null;
    case "done":
      return { type: "done" };
    case "error":
      return {
        type: "error",
        message: isStr(v.message) ? v.message : "Something went wrong",
        ...(isStr(v.code) && /^[a-z_]{1,40}$/.test(v.code) ? { code: v.code } : {}),
      };
    default:
      return null;
  }
}

/** Validates one interface step, from the turn stream or from Hydra Desktop's bridge. */
export function parseUi(v: unknown): UiEvent | null {
  if (!isObj(v)) return null;
  switch (v.kind) {
    case "navigate":
      return isSafePath(v.href) ? { kind: "navigate", href: v.href } : null;
    case "openPanel":
      return isStr(v.value) && /^[\w-]{1,100}$/.test(v.value) && (PANEL_PARAMS as readonly unknown[]).includes(v.param)
        ? { kind: "openPanel", param: v.param as PanelParam, value: v.value }
        : null;
    case "setScope":
      return scopeSchema.safeParse(v.scope).success ? { kind: "setScope", scope: v.scope as Scope } : null;
    case "highlight":
      return isStr(v.selector) && v.selector !== "" && v.selector.length <= 200 ? { kind: "highlight", selector: v.selector } : null;
    default:
      return null;
  }
}

/** One SSE frame ("data: {...}" lines) into a TurnEvent, or null. */
function parseFrame(frame: string): TurnEvent | null {
  const data = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(l.startsWith("data: ") ? 6 : 5))
    .join("\n");
  if (!data) return null;
  try {
    return parseTurnEvent(JSON.parse(data));
  } catch {
    return null;
  }
}

/** Reads a text/event-stream body into TurnEvents as the frames arrive. Frames end at a blank line. */
export async function* readTurnStream(body: ReadableStream<Uint8Array>): AsyncGenerator<TurnEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf = (buf + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buf.indexOf("\n\n")) >= 0) {
        const ev = parseFrame(buf.slice(0, end));
        buf = buf.slice(end + 2);
        if (ev) yield ev;
      }
      if (done) break;
    }
    const tail = parseFrame(buf);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
