import { SURFACES } from "@/lib/agent/events";
import { answeredBy, clampEffort, isEffort, type Provider } from "@/lib/agent/models";
import { readProviders } from "@/lib/agent/settings-client";
import { parseScope } from "@/lib/entities/model";
import { blip as defaultBlip, isIOS, openMic as defaultOpenMic } from "./audio";
import { createListener as defaultCreateListener, speechSupported, type Listener } from "./listener";
import type { SpeakerLike } from "./speaker";
import type { Activity, AgentPhase, AgentStatus, Approval, ClientSurface, Confirm, DesktopSnapshot, HydraDesktopBridge, Message, MessagePart, Scope, TurnEvent, UiEvent } from "./types";
import { desktopBridge, wokeOf } from "./desktop";
import { runUi, type Nav } from "./ui-events";
import { afterWakePhrase, hasSleepWord, isEcho, parseUi, parseYesNo, pickFiller, readTurnStream, stripEmotes, takeSentences, wordCount } from "./words";

/**
 * No answer this long after the owner finished: Hydra says a filler ("Let me check."). Long enough that a quick
 * answer (adaptive thinking takes a second or two) comes without one; a tool start brings one at once.
 */
export const FILLER_MS = 2500;
/** A second filler in one turn only for a tool that starts this long after the first one. */
export const SECOND_FILLER_MS = 6000;
/**
 * How long a finished sentence waits before it is spoken, in case a tool starts right after it: then it was narration
 * ("I need dates; today 2026-11-22.") and becomes a step, never spoken.
 * ponytail: a fixed grace; narration that outlasts it is already said. A brain that marks narration would remove it.
 */
export const STEP_GRACE_MS = 250;
/*
 * Barge-in: the owner's voice over Hydra's. Calibration knobs (the Meter scales RMS so speech reads 0.3 to 0.8; the
 * echo left after the browser's echo cancellation reads near the floor): tune these on a real room, not here.
 */
export const BARGE_MS = 250;
export const VAD_TICK_MS = 30;
/** The first frames of each spoken stretch set the floor: room noise plus Hydra's echo after cancellation. */
export const VAD_CALIBRATE_FRAMES = 6;
export const BARGE_MIN_LEVEL = 0.15;
export const BARGE_FLOOR_RATIO = 3;
/**
 * A voice barge-in only pauses Hydra at first: when no words of the owner's come this soon (a cough, a door), it
 * carries on where it stopped, like a person would.
 */
export const BARGE_RESUME_MS = 1500;
/**
 * The recognizer stays on from speaking into listening, so its late final of Hydra's last words can arrive after the
 * voice stopped: for this long, what is only Hydra's own words is still its echo.
 */
export const ECHO_TAIL_MS = 1500;

/** The words for a listening failure (the pill shows them briefly, the thread keeps them). */
export const MIC_OFF = "The microphone is off. Type instead.";
export const NOT_HEARING = "Not hearing you. Tap to try again.";
export const NOTHING_HEARD = "Didn't catch that.";
/** The same recognizer failure this many times in a row (the mic refused for good): a tap opens the typing sheet again. */
export const FATAL_REPEATS = 2;

const DESKTOP_STATES: Record<string, AgentStatus> = { Asleep: "asleep", Listening: "listening", Thinking: "thinking", Speaking: "speaking" };

/** Why a relay turn ended without the Mac's answer (the error codes of the W3 relay contract). */
export type MacIssue = "brain_offline" | "brain_timeout" | "brain_failed" | "offline" | "timeout" | "bad_event" | "failed" | "claude";
export const MAC_ISSUES: Record<string, MacIssue> = {
  // Neither Hydra's server nor the Mac is online (0121). mac_offline: an older server's word for it,
  // and today's for a turn typed in Hydra Desktop while no Mac is online.
  brain_offline: "brain_offline",
  // Hydra's server held the turn and timed out or went quiet (0121).
  brain_timeout: "brain_timeout",
  brain_failed: "brain_failed",
  mac_offline: "offline",
  mac_timeout: "timeout",
  mac_bad_event: "bad_event",
  mac_failed: "failed",
  mac_claude: "claude",
  mac_signed_out: "claude",
};
/** How long a flag this window set (detached, muted, paused) wins over pushes that still carry the old value. */
export const HOLD_MS = 2000;
/** A `ui` step already in the first snapshot runs only when the desktop stamped it this recently (else it is stale). */
export const FRESH_UI_MS = 10_000;
/** While the attached Mac thinks, how often the window looks for approvals it waits on. */
export const APPROVAL_POLL_MS = 4000;
type Held = "detached" | "muted" | "paused";
/** The desktop stamps each `ui` step with `at` (ms): the dedupe key. Without one, the object itself. */
const uiKey = (u: unknown) => (isObj(u) && typeof u.at === "number" && u.at > 0 ? u.at : u);

export const IDLE_MS = 5 * 60 * 1000;
export const DEFAULT_SLEEP_WORD = "Hydra, sleep";
/** Where an older client kept the sleep word on one device. Read once, moved to the server, then removed. */
export const LEGACY_SLEEP_WORD_KEY = "hydra:sleep-word";

export type AgentState = {
  status: AgentStatus;
  /** Hydra's voice is off: replies stream as text only. */
  muted: boolean;
  /** Hydra's speech is paused mid-reply. */
  paused: boolean;
  expanded: boolean;
  /** No speech recognizer (or the microphone was refused): the panel's typed input is the way to talk. */
  typedOnly: boolean;
  /** Hydra Desktop owns the microphone and the voice. */
  desktop: boolean;
  /** What this desktop's bridge can do (older desktops lack the v2/v3 methods). */
  can: { voice: boolean; detach: boolean };
  /** The desktop orb floats on the Mac instead of living in this window. */
  detached: boolean;
  /** The Mac agent's current reply and what it heard (desktop only). */
  reply: string;
  heard: string;
  /** The last turn ended because of the Mac brain: offline, no answer in time, or a bad event. */
  macIssue: MacIssue | null;
  interim: string;
  thread: Message[];
  /** The shared conversation the panel shows (its activity is "This chat"). */
  threadId: string | null;
  activity: Activity[];
  /** A live confirm the paused turn waits on. */
  confirm: Confirm | null;
  approvals: Approval[];
  error: string | null;
  sleepWord: string;
  /** What the agent is doing, for the thinking animation. */
  phase?: AgentPhase;
  /** The filler being said while it works ("Let me check."). Never stored in the thread. */
  filler?: string | null;
  /** Hydra Desktop listens only for its wake phrase: the card says so instead of Listening. */
  wakePhrase?: boolean;
  /** The shared agent settings (agent_settings, W6 contract): the orb menu edits them. */
  settings: VoiceSettings;
  /** Hydra Desktop's last clap or phrase wake (epoch ms): the orb's wake look. Cleared when it falls asleep. */
  wokeAt: number | null;
  /** 0220: the owner's avatars (the orb menu's quick switch) and the active one (null: Hydra's own voice). Unset until read. */
  avatars?: { id: string; name: string }[];
  activeAvatarId?: string | null;
  /** The model providers the owner can pick now (GET /api/agent/state `providers`; models.ts). Unset: Claude only. */
  providers?: Provider[];
};

/** Clap sensitivity's levels. Models and efforts: src/lib/agent/models.ts. */
export const LEVELS = ["low", "medium", "high"] as const;
export type Level = (typeof LEVELS)[number];
/** What the orb menu edits besides the sleep word (PATCH /api/agent/state). */
export type VoiceSettings = { wakePhrase: string; clapSensitivity: Level; model: string; effortLive: string; effortRoutine: string; approveAll: boolean };
export const DEFAULT_WAKE_PHRASE = "Hey Hydra";
const DEFAULT_VOICE: VoiceSettings = {
  wakePhrase: DEFAULT_WAKE_PHRASE,
  clapSensitivity: "medium",
  model: "claude-opus-5-5",
  effortLive: "low",
  effortRoutine: "medium",
  approveAll: false,
};
/** What approve all means, wherever it is shown (orb menu, Settings, the panel tag). */
export const APPROVE_ALL_INFO = "Hydra acts without asking. Deletions still ask.";
/** Spectrum bands the orb draws (W5 section 5): Hydra Desktop sends 24; the web makes the same from its analysers. */
export const BANDS = 24;

export type ControllerDeps = {
  fetch: typeof fetch;
  nav: Nav;
  speaker: SpeakerLike;
  createListener: typeof defaultCreateListener;
  openMic: typeof defaultOpenMic;
  blip: () => void;
  supported: () => boolean;
  /** Runs one interface step. Defaults to the Next router steps in ui-events. */
  runUi?: (ev: UiEvent) => void;
  /** The page the owner is on, sent with each turn. Defaults to window.location. */
  here?: () => { path: string; search: string };
  /** web or phone (desktop when the bridge is there). Defaults to the phone breakpoint. */
  surface?: () => ClientSurface;
  /** Where an older client kept the sleep word (moved to the server once). Defaults to localStorage. */
  storage?: Pick<Storage, "getItem" | "removeItem">;
  idleMs?: number;
  /** Barge-in while Hydra speaks. Defaults to everywhere but iOS, where a tap on the orb interrupts instead. */
  bargeIn?: () => boolean;
  random?: () => number;
  now?: () => number;
  fillerMs?: number;
  stepGraceMs?: number;
};

/** The voice side of the turn in flight: the open text segment and what has been said of it. */
type TurnVoice = {
  replyId: string;
  /** The open text segment, raw (tags and all), and the index of its part. */
  seg: string;
  segIdx: number | null;
  /** Sentences of the open segment already sent to the speaker. */
  segSaid: number;
  grace: ReturnType<typeof setTimeout> | undefined;
  fillerTimer: ReturnType<typeof setTimeout> | undefined;
  /** Answer text has been spoken since the last tool started. */
  answering: boolean;
  /** Tools started and not finished. */
  running: number;
  fillers: number;
  lastFillerAt: number;
  /** The owner barged in: the rest of this turn streams as text only. */
  silenced: boolean;
  /** The server's id for this turn (the `turn` event): words added while it works go to it (0191). */
  turnId: string | null;
  /** Words added before the turn id came: sent once it does. */
  pending: { id: string; text: string; spoken?: boolean }[];
};

const INITIAL: AgentState = {
  status: "asleep",
  muted: false,
  paused: false,
  expanded: false,
  typedOnly: false,
  desktop: false,
  can: { voice: false, detach: false },
  detached: false,
  reply: "",
  heard: "",
  macIssue: null,
  interim: "",
  thread: [],
  threadId: null,
  activity: [],
  confirm: null,
  approvals: [],
  error: null,
  sleepWord: DEFAULT_SLEEP_WORD,
  phase: "idle",
  filler: null,
  wakePhrase: false,
  settings: DEFAULT_VOICE,
  wokeAt: null,
};

const json = { "content-type": "application/json" };
let seq = 0;
const uid = (p: string) => `${p}${++seq}`;

const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

function scopeOf(search: string): Scope {
  return parseScope(new URLSearchParams(search).get("scope"));
}

function localStore(): Pick<Storage, "getItem" | "removeItem"> | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** The /api/agent/state activity rows. */
function toActivity(rows: unknown[]): Activity[] {
  const str = (v: unknown) => (isStr(v) ? v : null);
  return rows.filter(isObj).flatMap((r) =>
    isStr(r.id)
      ? [{ id: r.id, label: str(r.summary) ?? "", undoId: str(r.undoId), undone: isStr(r.undoneAt), createdAt: str(r.createdAt), threadId: str(r.threadId), surface: str(r.surface) }]
      : [],
  );
}

/** The shared conversation: a thread a person talks in (web, phone, desktop), never a routine's or an MCP client's. */
function liveThread(rows: unknown): { id: string; messages: unknown } | null {
  if (!Array.isArray(rows)) return null;
  const t = rows.find((r) => isObj(r) && isStr(r.id) && (SURFACES as readonly unknown[]).includes(r.surface));
  return t ? { id: t.id, messages: t.messages } : null;
}

/** The thread's stored messages (text only, oldest first) as the panel's conversation. */
function toMessages(rows: unknown): Message[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter(isObj).flatMap((r) =>
    isStr(r.id) && isStr(r.text) && r.text && (r.role === "user" || r.role === "assistant")
      ? [{ id: r.id, role: r.role === "user" ? ("user" as const) : ("hydra" as const), text: r.role === "user" ? r.text : stripEmotes(r.text, true) }]
      : [],
  ).filter((m) => m.text);
}

/** The reply with new parts, and its `text` the answer they hold. */
function withParts(m: Message, parts: MessagePart[]): Message {
  const text = parts.flatMap((p) => (p.kind === "text" && p.text.trim() ? [p.text.trim()] : [])).join(" ");
  return { ...m, parts, text };
}

/** A message worth keeping: the owner's, or a reply with words or steps (an empty bubble goes). */
const hasContent = (m: Message) => m.role === "user" || m.text !== "" || !!m.parts?.length;

/** Approvals waiting from routines and MCP clients. A live one belongs to its own turn's confirm card. */
function toApprovals(rows: unknown[]): Approval[] {
  return rows.filter(isObj).flatMap((r) => (isStr(r.id) && r.source !== "live" ? [{ id: r.id, prompt: isStr(r.summary) ? r.summary : "" }] : []));
}

/** The shared settings in /api/agent/state (an older server sends only some): the rest keep what they were. Null when none changed. */
function voiceSettingsOf(raw: unknown, was: VoiceSettings): VoiceSettings | null {
  if (!isObj(raw)) return null;
  const pick = (k: Exclude<keyof VoiceSettings, "approveAll">, ok: (v: string) => boolean) => (isStr(raw[k]) && ok(raw[k] as string) ? (raw[k] as string) : was[k]);
  const next: VoiceSettings = {
    wakePhrase: pick("wakePhrase", (v) => v.trim().length >= 2).trim(),
    clapSensitivity: pick("clapSensitivity", (v) => (LEVELS as readonly string[]).includes(v)) as Level,
    model: pick("model", (v) => v.length > 0),
    effortLive: pick("effortLive", (v) => v.length > 0),
    effortRoutine: pick("effortRoutine", (v) => v.length > 0),
    approveAll: typeof raw.approveAll === "boolean" ? raw.approveAll : was.approveAll,
  };
  return (Object.keys(next) as (keyof VoiceSettings)[]).some((k) => next[k] !== was[k]) ? next : null;
}

/** The server's error body: { message } or { error }. */
function errorOf(body: unknown, fallback: string): string {
  if (isObj(body)) {
    if (isStr(body.message)) return body.message;
    if (isObj(body.error) && isStr(body.error.message)) return body.error.message;
  }
  return fallback;
}

/**
 * The agent client: one state machine for the card, the phone orb and the panel.
 * asleep -> (tap) listening -> (heard) thinking -> speaking -> listening; 5 idle minutes or the sleep word -> asleep.
 * The recognizer is off while Hydra thinks or speaks, so it never hears its own voice; tapping the orb interrupts.
 * While a turn waits on a confirm, the stream stays open and the recognizer listens for a spoken yes or no.
 */
export class AgentController {
  private state: AgentState = INITIAL;
  private subs = new Set<() => void>();
  private awake = false;
  private turning = false;
  private speaking = false;
  private desktopState: AgentStatus | null = null;
  private bridge: HydraDesktopBridge | null = null;
  private levels = { mic: 0, out: 0 };
  /** The last spectrum Hydra Desktop pushed (W5 section 5), unvalidated values: clamped when read. */
  private desktopBands: unknown[] | null = null;
  /** The last `ui` the bridge pushed (its `at` stamp, or the object): a snapshot repeats it with every level update. */
  private lastUi: unknown = undefined;
  /** The `woke.at` already shown: the bridge repeats the last snapshot every 66 ms. */
  private lastWoke = 0;
  /** Flags this window just set, until the desktop echoes them (or HOLD_MS passes). */
  private held: Partial<Record<Held, { v: boolean; until: number }>> = {};
  /** The Mac's finished reply (its id) and what it heard for it: cleared on done, though the snapshot keeps them. */
  private doneReply: unknown = undefined;
  private doneHeard: unknown = undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private listener: Listener | null = null;
  /** The recognizer picked up speech since his last words: a tap that finds no words then says it missed them. */
  private spoke = false;
  /** The last recognizer failure and how many times in a row it came. */
  private fatal = { reason: "", n: 0 };
  private mic: Awaited<ReturnType<typeof defaultOpenMic>> = null;
  private micPending = false;
  private abort: AbortController | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private idleMs: number;
  /** The shared thread: from the first `thread` event, or the latest thread on the server. */
  private threadId: string | null = null;
  /** The active avatar's Fish voice id the last refresh saw (undefined: none read yet). */
  private voiceId: string | null | undefined = undefined;
  /** The voice side of the turn in flight (null between turns). */
  private tv: TurnVoice | null = null;
  /** What Hydra said this turn (answer, fillers, errors): the recognizer hearing these words is its own echo. */
  private said: string[] = [];
  /** What Hydra had said when the owner cut in: the next turn's interruptedAfter. */
  private cutOff: string | null = null;
  private lastFiller: string | null = null;
  private nextFiller: string | null = null;
  private vad: { timer: ReturnType<typeof setInterval>; frames: number; floor: number; over: number } | null = null;
  /** A voice barge-in paused Hydra; it resumes when this fires and no words of the owner's came. */
  private bargeHold: ReturnType<typeof setTimeout> | undefined;
  /** When Hydra's voice last went quiet (the echo tail starts here). */
  private quietAt = -Infinity;
  private canBarge: boolean;
  private now: () => number;

  constructor(private d: ControllerDeps) {
    this.state = INITIAL;
    this.idleMs = d.idleMs ?? IDLE_MS;
    // iOS Safari: no barge-in by voice (the mic cannot stay open while audio plays); a tap on the orb interrupts.
    this.canBarge = (d.bargeIn ?? (() => !isIOS()))();
    this.now = d.now ?? (() => Date.now());
    d.speaker.onBusy((busy) => {
      this.speaking = busy;
      if (!busy) {
        this.quietAt = this.now();
        this.patch({ paused: false });
      }
      this.sync();
    });
  }

  /* ---- store ---- */
  subscribe = (cb: () => void) => {
    this.subs.add(cb);
    return () => void this.subs.delete(cb);
  };
  getSnapshot = () => this.state;
  getServerSnapshot = () => INITIAL;
  private patch(p: Partial<AgentState>) {
    this.state = { ...this.state, ...p };
    this.subs.forEach((cb) => cb());
  }

  /** Client-only setup: feature detection and Hydra Desktop's bridge. Returns the cleanup. */
  init(bridge: HydraDesktopBridge | undefined = typeof window === "undefined" ? undefined : desktopBridge(window.hydraDesktop)): () => void {
    const offs: (() => void)[] = [];
    if (bridge) {
      this.bridge = bridge;
      const fn = (k: keyof HydraDesktopBridge) => typeof bridge[k] === "function";
      const first = bridge.snapshot();
      // A step the Mac sent just before this page started runs; an old one (or one with no stamp) never replays.
      const at = isObj(first.ui) ? first.ui.at : undefined;
      this.lastUi = typeof at === "number" && at > 0 && Date.now() - at < FRESH_UI_MS ? undefined : uiKey(first.ui);
      this.patch({ desktop: true, can: { voice: fn("stop") && fn("pause") && fn("resume") && fn("setMuted"), detach: fn("detach") && fn("attach") } });
      this.onSnapshot(first);
      offs.push(bridge.subscribe((s) => this.onSnapshot(s)));
    } else {
      this.patch({ typedOnly: !this.d.supported() });
    }
    this.sync();
    return () => {
      offs.forEach((f) => f());
      this.bridge = null;
      this.desktopState = null;
      this.lastUi = undefined;
      this.lastWoke = 0;
      this.held = {};
      this.teardown();
    };
  }

  /** One push from Hydra Desktop: state, levels, voice flags, reply and heard text, and maybe an interface step. */
  private onSnapshot(s: DesktopSnapshot) {
    if (!isObj(s)) return;
    const st = DESKTOP_STATES[s.state as string];
    const was = this.desktopState;
    if (st) this.desktopState = st;
    const lvl = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
    this.levels = { mic: lvl(s.micLevel), out: lvl(s.outputLevel) };
    this.desktopBands = Array.isArray(s.bands) && s.bands.length === BANDS ? s.bands : null;
    // Reply and heard show while the Mac's turn runs and clear on done (the final reply, then back to listening, or
    // asleep), though the merged snapshot keeps repeating them. On done the shared thread reloads, so the panel shows
    // that turn once. The Mac clears `reply` itself when a new turn starts.
    const reply = isObj(s.reply) && isStr(s.reply.text) ? { key: isStr(s.reply.id) ? s.reply.id : s.reply.text, text: s.reply.text, final: s.reply.final === true } : null;
    const heard = isObj(s.heard) && isStr(s.heard.text) ? s.heard.text : null;
    const busy = this.desktopState === "thinking" || this.desktopState === "speaking";
    const over = !busy && (this.desktopState === "asleep" || reply?.final === true);
    if (over && (reply || heard) && (reply?.key !== this.doneReply || s.heard !== this.doneHeard)) {
      const fresh = !!reply && reply.key !== this.doneReply;
      this.doneReply = reply?.key;
      this.doneHeard = s.heard;
      if (fresh) void this.refresh(true);
    }
    const p: Partial<AgentState> = {
      detached: this.flag("detached", s.detached === true),
      reply: reply && reply.key !== this.doneReply ? stripEmotes(reply.text, !reply.final).slice(0, 4000) : "",
      heard: heard && s.heard !== this.doneHeard ? heard.slice(0, 1000) : "",
      wakePhrase: s.wake === "phrase",
    };
    // The wake look: once per wake (deduped on `at`), only when fresh (a replayed or stale one never plays), and it
    // ends when Hydra falls asleep. A web or menu wake carries none.
    if (st === "asleep" && was !== "asleep") p.wokeAt = null;
    const woke = wokeOf(s.woke);
    if (woke && woke.at !== this.lastWoke) {
      this.lastWoke = woke.at;
      // A stamp ahead of this clock (skew) plays now: the orb counts from wokeAt, so a future one would hold the burst.
      if (Math.abs(Date.now() - woke.at) < FRESH_UI_MS) p.wokeAt = Math.min(woke.at, Date.now());
    }
    if (typeof s.muted === "boolean") p.muted = this.flag("muted", s.muted);
    if (typeof s.paused === "boolean") p.paused = this.flag("paused", s.paused);
    else if (this.desktopState !== "speaking") p.paused = false;
    if ((Object.keys(p) as (keyof AgentState)[]).some((k) => this.state[k] !== p[k])) this.patch(p);
    if (s.ui !== undefined && s.ui !== null && uiKey(s.ui) !== this.lastUi) {
      this.lastUi = uiKey(s.ui);
      // The bridge is native code, but what it forwards came from a model: validate it like the turn stream.
      const ev = parseUi(s.ui);
      if (ev) this.exec(ev);
    }
    this.sync();
  }

  /** A flag the desktop pushed, unless this window just set it otherwise and the desktop has not caught up. */
  private flag(k: Held, pushed: boolean): boolean {
    const h = this.held[k];
    if (!h) return pushed;
    if (pushed === h.v || Date.now() > h.until) {
      delete this.held[k];
      return pushed;
    }
    return h.v;
  }
  private hold(k: Held, v: boolean) {
    this.held[k] = { v, until: Date.now() + HOLD_MS };
  }

  /* ---- status ---- */
  private sync() {
    // A turn the owner barged in on still streams its text, but Hydra listens to him meanwhile.
    const waiting = this.turning && !this.state.confirm && !this.tv?.silenced && !this.bargeHold;
    const status: AgentStatus = this.desktopState ?? (!this.awake ? "asleep" : this.speaking ? "speaking" : waiting ? "thinking" : "listening");
    // While Hydra speaks the recognizer stays on for a barge-in (never on iOS); what it hears of Hydra's own voice is
    // dropped as echo (see bargeWords).
    const barge = status === "speaking" && !this.bridge && this.canBarge;
    // Thinking, it still listens: his words are added to the turn (0191), and the sleep word cancels it and sleeps.
    const wantListen = (status === "listening" || status === "thinking" || barge) && !this.bridge && !this.state.typedOnly;
    if (wantListen && !this.listener) {
      this.listener = this.d.createListener({
        onInterim: (t) => {
          if (this.state.status === "speaking" && !this.bargeWords(t)) return;
          if (this.echoTail(t)) return;
          if (this.bargeHold) this.bargeIn(); // his words came: the paused reply ends
          this.words();
          this.bump();
          this.patch({ interim: t });
          if (hasSleepWord(t, this.state.sleepWord)) this.heard(t);
        },
        onFinal: (t) => {
          if (this.state.status === "speaking" && !this.bargeWords(t)) return;
          if (this.echoTail(t)) return;
          if (this.bargeHold) this.bargeIn();
          this.words();
          this.heard(t, true);
        },
        onSpeech: () => {
          if (this.state.status === "listening") this.spoke = true;
        },
        // Thinking, a quiet recognizer session is normal: it never counts as the iOS deaf state.
        expecting: () => this.state.status === "listening",
        onFatal: (reason) => {
          this.listener = null;
          this.fatal = { reason, n: reason === this.fatal.reason ? this.fatal.n + 1 : 1 };
          this.patch({ typedOnly: true, interim: "", error: reason === "no-result" ? NOT_HEARING : MIC_OFF });
        },
      });
      this.listener?.start();
    } else if (!wantListen && this.listener) {
      this.listener.stop();
      this.listener = null;
      if (this.state.interim) this.patch({ interim: "" });
    }
    if (barge && this.mic && !this.vad) this.vad = { timer: setInterval(() => this.vadTick(), VAD_TICK_MS), frames: 0, floor: 0, over: 0 };
    else if (!(barge && this.mic) && this.vad) this.stopVad();
    const phase = this.phaseOf(status);
    if (status !== this.state.status || phase !== this.state.phase) this.patch({ status, phase });
    // The attached Mac is working: approvals it asks for (send, delete, a risky click) show here as they arrive.
    const poll = !!this.bridge && status === "thinking";
    if (poll && !this.poll) this.poll = setInterval(() => void this.refresh(), APPROVAL_POLL_MS);
    else if (!poll && this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  private phaseOf(status: AgentStatus): AgentPhase {
    if (this.bridge) return status === "thinking" ? "thinking" : status === "speaking" ? "speaking" : "idle";
    const tv = this.tv;
    if (this.speaking && (!this.turning || tv?.answering)) return "speaking";
    if (this.turning && !this.state.confirm && !tv?.silenced && !this.bargeHold) return tv?.running ? "checking" : "thinking";
    return this.speaking ? "speaking" : "idle";
  }

  /** One meter frame while Hydra speaks: the owner's voice over the calibrated floor for BARGE_MS cuts it off. */
  private vadTick() {
    const v = this.vad;
    if (!v || !this.mic) return;
    const lvl = this.mic.meter.read();
    if (v.frames < VAD_CALIBRATE_FRAMES) {
      // The floor is Hydra's echo: measure it only once its audio really plays (a Fish sentence is still downloading
      // when the voice turns busy, and the room's silence would set the bar far too low).
      if (this.d.speaker.audible && !this.d.speaker.audible()) return;
      v.floor = (v.floor * v.frames + lvl) / (v.frames + 1);
      v.frames++;
      return;
    }
    if (lvl > Math.max(BARGE_MIN_LEVEL, v.floor * BARGE_FLOOR_RATIO)) v.over += VAD_TICK_MS;
    else {
      // Gaps between syllables do not reset it at once; quiet frames pull the floor along slowly.
      v.over = Math.max(0, v.over - VAD_TICK_MS);
      v.floor = v.floor * 0.97 + lvl * 0.03;
    }
    if (v.over >= BARGE_MS) this.holdBarge();
  }

  /**
   * The owner's voice over Hydra's: it goes quiet at once (paused, so nothing is lost) and listens. His words start
   * the next turn, which ends this one; no words within BARGE_RESUME_MS (a cough) and it carries on.
   */
  private holdBarge() {
    this.markCutOff();
    this.stopVad();
    this.d.speaker.pause();
    this.speaking = false;
    this.quietAt = this.now();
    this.bargeHold = setTimeout(() => {
      this.bargeHold = undefined;
      if (!this.awake || !this.d.speaker.busy) return;
      this.cutOff = null;
      this.d.speaker.resume();
      this.speaking = true;
      this.sync();
    }, BARGE_RESUME_MS);
    this.bump();
    this.sync();
  }

  /**
   * What Hydra had said when the owner cut in: the next turn's interruptedAfter. Over a filler while the turn still
   * works, nothing was cut off (his words join that turn and its answer is still said), so nothing carries over.
   */
  private markCutOff() {
    if (this.turning && this.tv && !this.tv.answering) {
      this.cutOff = null;
      return;
    }
    const spoken = (this.d.speaker.played?.() ?? this.said).join(" ").trim();
    if (spoken) this.cutOff = spoken.slice(0, 4000);
  }

  private dropBargeHold() {
    clearTimeout(this.bargeHold);
    this.bargeHold = undefined;
  }

  /** Just after Hydra went quiet, words that are only its own are the recognizer's late echo of it, not the owner. */
  private echoTail(t: string): boolean {
    const st = this.state.status;
    if ((st !== "listening" && st !== "thinking") || this.now() - this.quietAt >= ECHO_TAIL_MS) return false;
    if ((this.state.confirm && parseYesNo(t)) || hasSleepWord(t, this.state.sleepWord)) return false;
    return isEcho(t, this.said.join(" "));
  }

  private stopVad() {
    if (this.vad) clearInterval(this.vad.timer);
    this.vad = null;
  }

  /**
   * Words the recognizer heard while Hydra speaks. Two or more that are not Hydra's own (its voice leaking into the
   * mic), or a yes or no to a waiting confirm, or the sleep word: the owner cut in. True when it was a barge-in.
   */
  private bargeWords(t: string): boolean {
    const answers = !!this.state.confirm && parseYesNo(t) !== null;
    const sleepy = hasSleepWord(t, this.state.sleepWord);
    if (!answers && !sleepy && (wordCount(t) < 2 || isEcho(t, this.said.join(" ")))) return false;
    this.bargeIn();
    return true;
  }

  /** The owner talks over Hydra: its voice stops at once, the rest of the reply is not spoken, and it listens. */
  private bargeIn() {
    this.dropBargeHold();
    this.markCutOff();
    // Over the answer: the rest of it is not said. Over a filler ("Let me check.") while it still works: only the
    // filler stops, and his words are added to the turn (0191), whose answer is still said.
    if (this.tv && (this.tv.answering || !this.turning)) this.tv.silenced = true;
    this.stopVad();
    this.d.speaker.stop();
    this.speaking = false;
    this.patch({ paused: false, filler: null });
    this.bump();
    this.sync();
  }

  /* ---- what Hydra says while a turn runs ---- */
  private patchReply(replyId: string, fn: (parts: MessagePart[]) => MessagePart[]) {
    this.patch({ thread: this.state.thread.map((m) => (m.id === replyId ? withParts(m, fn([...(m.parts ?? [])])) : m)) });
  }

  /** Sends the open segment's finished sentences to the speaker (`flush`: the unfinished end too). */
  private release(flush: boolean) {
    const tv = this.tv;
    if (!tv) return;
    clearTimeout(tv.grace);
    tv.grace = undefined;
    const { sentences } = takeSentences(stripEmotes(tv.seg, flush), flush);
    const fresh = sentences.slice(tv.segSaid);
    tv.segSaid = sentences.length;
    if (!fresh.length) return;
    tv.answering = true;
    clearTimeout(tv.fillerTimer);
    if (this.state.filler) this.patch({ filler: null });
    if (!this.state.muted && !tv.silenced) fresh.forEach((s) => this.voice(s));
    this.sync();
  }

  private voice(s: string, filler = false) {
    this.said.push(s);
    if (filler) this.d.speaker.say(s, { filler: true });
    else this.d.speaker.say(s);
  }

  /** Closes the open text segment: what follows starts a new part. */
  private closeSegment() {
    const tv = this.tv!;
    clearTimeout(tv.grace);
    tv.grace = undefined;
    tv.seg = "";
    tv.segIdx = null;
    tv.segSaid = 0;
  }

  /**
   * "Let me check." while it works: when no answer came FILLER_MS after the owner finished, or when a tool starts.
   * One per turn, a second only for a tool that starts SECOND_FILLER_MS after the first; never while muted, while the
   * answer is being said, or the same line twice in a row.
   */
  private filler(reason: "wait" | "tool") {
    const tv = this.tv;
    if (!tv || tv.silenced || tv.answering || this.state.muted || this.state.confirm || this.speaking) return;
    if (reason === "wait" && tv.seg.trim()) return; // text is arriving: if it is narration, its tool brings the filler
    if (tv.fillers >= 2 || (tv.fillers === 1 && (reason !== "tool" || this.now() - tv.lastFillerAt < SECOND_FILLER_MS))) return;
    const line = this.nextFiller && this.nextFiller !== this.lastFiller ? this.nextFiller : pickFiller(this.lastFiller, this.d.random);
    this.nextFiller = null;
    this.lastFiller = line;
    tv.fillers++;
    tv.lastFillerAt = this.now();
    clearTimeout(tv.fillerTimer);
    this.voice(line, true);
    this.patch({ filler: line });
  }

  private bump() {
    clearTimeout(this.idle);
    if (this.awake) this.idle = setTimeout(() => this.sleep(), this.idleMs);
  }

  private teardown() {
    clearTimeout(this.idle);
    this.dropBargeHold();
    clearInterval(this.poll);
    this.poll = undefined;
    this.abort?.abort();
    this.abort = null;
    this.endVoice();
    this.stopVad();
    this.d.speaker.stop();
    this.listener?.stop();
    this.listener = null;
    this.mic?.close();
    this.mic = null;
  }

  /**
   * The meter mic: the orb's level while it listens, and barge-in by voice. Never on iOS (no barge-in there): an open
   * capture reroutes or ducks Hydra's voice, and the recognizer has its own; the orb falls back to its level.
   */
  private async startMic() {
    if (this.mic || this.micPending || this.bridge || !this.canBarge) return;
    this.micPending = true;
    const mic = await this.d.openMic();
    this.micPending = false;
    if (!this.awake) mic?.close();
    else {
      this.mic = mic;
      this.sync();
    }
  }

  /** The turn's voice state ends: its timers stop and the filler line clears. */
  private endVoice() {
    if (this.tv) {
      clearTimeout(this.tv.grace);
      clearTimeout(this.tv.fillerTimer);
    }
    this.tv = null;
    if (this.state.filler) this.patch({ filler: null });
  }

  /** 0..1, read every frame by the orb. */
  level = (): number => {
    const { status } = this.state;
    if (this.bridge) return status === "speaking" ? this.levels.out : status === "listening" ? this.levels.mic : 0;
    if (status === "speaking") return this.d.speaker.level();
    if (status === "listening") return this.mic?.meter.read() ?? 0;
    return 0;
  };

  /**
   * The spectrum the orb draws, read every frame without a render (W5 section 5): `out` gets BANDS values 0..1, low to
   * high. Hydra's voice while it speaks, the microphone while it listens; Hydra Desktop's own bands when attached.
   * False when there is none (thinking, asleep, no analyser): the orb falls back to the level.
   */
  bands = (out: Float32Array): boolean => {
    const { status } = this.state;
    if (this.bridge) {
      const b = this.desktopBands;
      if (!b || (status !== "speaking" && status !== "listening")) return false;
      for (let i = 0; i < BANDS; i++) {
        const v = b[i];
        out[i] = typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
      }
      return true;
    }
    if (status === "speaking") return this.d.speaker.bands?.(out) ?? false;
    if (status === "listening") return this.mic?.meter.bands?.(out) ?? false;
    return false;
  };

  /** His words reached the recognizer: voice works. */
  private words() {
    this.spoke = false;
    this.fatal = { reason: "", n: 0 };
  }

  /** The microphone stays open for the recognizer: the speaker then must not prime speechSynthesis in this tap. */
  private micOpen() {
    return this.d.supported() && !this.state.typedOnly;
  }

  /* ---- controls ---- */
  wake = () => {
    if (this.bridge) return this.bridge.wake();
    // A recognizer that failed or went deaf gets another try on each tap (it may only have been the page in the background).
    if (this.d.supported() && (this.state.typedOnly || this.state.error)) this.patch({ typedOnly: false, error: null });
    this.d.speaker.unlock?.(this.micOpen()); // inside the tap: iPhone Safari plays Hydra's voice only after a tap started audio
    if (!this.awake) {
      this.awake = true;
      this.spoke = false;
      void this.startMic();
    }
    this.bump();
    this.sync();
  };

  sleep = () => {
    if (this.bridge) return this.bridge.sleep();
    this.awake = false;
    this.turning = false;
    this.speaking = false;
    this.cutOff = null;
    this.teardown();
    this.patch({ paused: false, interim: "", confirm: null });
    this.sync();
  };

  /** Tap or click on the orb. */
  tapOrb = () => {
    const { status, typedOnly } = this.state;
    if (status === "asleep") {
      this.wake();
      if (this.state.typedOnly || this.fatal.n >= FATAL_REPEATS) this.setExpanded(true);
    } else if (status === "speaking") {
      // Barge in: Hydra stops talking and listens. An older desktop (v1/v2) has no interrupt, so the tap puts it to
      // sleep, which also silences it: a tap never does nothing (owner: "when I tap on the visalizer nothing happens").
      if (this.bridge) {
        this.endTurn();
        this.interruptDesktop();
      } else {
        // Tap-to-interrupt (the only way on iOS): the next turn knows where it was cut off, like a voice barge-in.
        const spoken = (this.d.speaker.played?.() ?? this.said).join(" ").trim();
        if (spoken) this.cutOff = spoken.slice(0, 4000);
        this.endTurn();
        this.sync();
      }
    } else if (status === "listening") {
      if (typedOnly) {
        // Voice failed: try it again, unless it failed the same way FATAL_REPEATS times (then it types).
        if (this.d.supported() && !this.bridge && this.fatal.n < FATAL_REPEATS) this.wake();
        else this.setExpanded(true);
      } else this.sendHeard();
    }
  };

  /**
   * A tap while it listens. Owner: "it doesn't really stop listening once I end my speech": what it heard so far is
   * sent at once, without waiting for the recognizer's final. Nothing heard: it turns off (owner: "if I tap on the
   * visualiser when it's listening it should shut off"), and says it missed him only if the recognizer heard speech.
   */
  private sendHeard() {
    const said = this.state.interim.trim();
    if (!said || this.bridge) {
      const missed = this.spoke && !this.bridge;
      this.sleep();
      if (missed) this.patch({ error: NOTHING_HEARD });
      return;
    }
    // The recognizer's session ends here, so its late final never says the same words twice; a new one listens.
    this.listener?.stop();
    this.listener = null;
    this.heard(said, true);
    this.sync();
  }

  toggleMute = () => {
    const muted = !this.state.muted;
    if (this.bridge) {
      if (!this.state.can.voice) return;
      this.hold("muted", muted); // before the call: a desktop may echo it at once
      this.patch({ muted });
      this.bridge.setMuted?.(muted);
      return;
    }
    if (muted) this.d.speaker.stop();
    this.patch({ muted, paused: false });
  };

  togglePause = () => {
    if (this.bridge ? this.state.status !== "speaking" || !this.state.can.voice : !this.speaking) return;
    const paused = !this.state.paused;
    if (this.bridge) {
      this.hold("paused", paused);
      this.patch({ paused });
      if (paused) this.bridge.pause?.();
      else this.bridge.resume?.();
      return;
    }
    if (paused) this.d.speaker.pause();
    else this.d.speaker.resume();
    this.patch({ paused });
  };

  /**
   * The Stop button, never off: Hydra's speech, the listening and any running turn end, and it sleeps (a tap
   * wakes it). Asleep, it changes nothing. On the Mac: its own stop (v3), or sleep on an older desktop.
   */
  stop = () => {
    // Owner: "stop button on agent isnt working". Inside Hydra Desktop the window's own turn and voice (a turn typed
    // here, the Fish or browser voice) must end too, not only the Mac's: end them first, then tell the Mac.
    // Owner: "stop button still doesnt put it to sleep": Stop means stop talking AND sleep, on every surface.
    this.endTurn();
    if (this.bridge && this.state.can.voice) this.interruptDesktop(); // v3: silence first; v1/v2: sleep below does it
    this.sleep();
  };

  /** Silences Hydra Desktop's voice without sleeping it (v3); an older desktop (v1/v2) has no interrupt, so it sleeps. */
  private interruptDesktop() {
    if (!this.bridge) return;
    if (!this.state.can.voice) return this.bridge.sleep();
    this.hold("paused", false);
    this.patch({ paused: false });
    this.bridge.stop?.();
  }

  /** Cancels the turn in flight and Hydra's speech; the reply so far stays (an empty one goes). */
  private endTurn() {
    this.dropBargeHold();
    this.abort?.abort();
    this.abort = null;
    this.endVoice();
    this.d.speaker.stop();
    this.turning = false;
    this.speaking = false;
    this.patch({ paused: false, confirm: null, thread: this.state.thread.filter(hasContent) });
  }

  /** The orb leaves this window and floats on the Mac (v2+), or comes back. */
  detach = () => {
    if (!this.bridge || !this.state.can.detach) return;
    this.hold("detached", true); // before the call: a desktop may echo it at once
    this.patch({ detached: true });
    this.bridge.detach?.();
  };
  attach = () => {
    if (!this.bridge || !this.state.can.detach) return;
    this.hold("detached", false);
    this.patch({ detached: false });
    this.bridge.attach?.();
  };

  setExpanded = (expanded: boolean) => {
    this.patch({ expanded });
    if (expanded) void this.refresh();
  };

  /** The sleep word setting, shared by every device (agent_settings.sleep_word). An empty word goes back to the default. */
  setSleepWord = async (word: string): Promise<boolean> => {
    const before = this.state.sleepWord;
    const sleepWord = word.trim().slice(0, 60) || DEFAULT_SLEEP_WORD;
    this.patch({ sleepWord });
    const ok = await this.send("PATCH", "/api/agent/state", { sleepWord });
    if (!ok && this.state.sleepWord === sleepWord) this.patch({ sleepWord: before });
    return ok;
  };

  /**
   * One shared setting from the orb menu (wake phrase, clap sensitivity, model, efforts, approve all): shown at once, saved through
   * PATCH /api/agent/state, put back when the server refuses it. An empty wake phrase goes back to the default.
   */
  setSetting = async (patch: Partial<VoiceSettings>): Promise<boolean> => {
    const clean = { ...patch };
    if (clean.wakePhrase !== undefined) clean.wakePhrase = clean.wakePhrase.trim().slice(0, 40) || DEFAULT_WAKE_PHRASE;
    const before = this.state.settings;
    const next = { ...before, ...clean };
    // A new model runs the efforts at its own levels: shown at once, clamped the same way on the server.
    if (clean.model !== undefined) {
      for (const k of ["effortLive", "effortRoutine"] as const) if (clean[k] === undefined && isEffort(next[k])) next[k] = clampEffort(clean.model, next[k]);
    }
    this.patch({ settings: next });
    const ok = await this.send("PATCH", "/api/agent/state", clean);
    if (!ok && this.state.settings === next) this.patch({ settings: before });
    return ok;
  };

  /** 0220: the avatar every device speaks and talks as (null: Hydra's own voice), from the orb menu. Put back when refused. */
  setAvatar = async (id: string | null): Promise<boolean> => {
    const before = this.state.activeAvatarId ?? null;
    this.patch({ activeAvatarId: id });
    this.d.speaker.forget?.();
    const ok = await this.send("PATCH", "/api/agent/state", { activeAvatarId: id });
    if (!ok && this.state.activeAvatarId === id) this.patch({ activeAvatarId: before });
    if (ok) await this.refresh(); // the avatar's voice id, for the next change
    return ok;
  };

  /* ---- talking ---- */
  /** One utterance, spoken or typed: the sleep word, a yes or no to a pending confirm, or a request. */
  heard = (raw: string, spoken = false) => {
    const text = raw.trim();
    if (!text) return;
    if (hasSleepWord(text, this.state.sleepWord)) {
      this.d.blip();
      this.sleep();
      return;
    }
    const { confirm } = this.state;
    const answer = confirm ? parseYesNo(text) : null;
    if (confirm && answer) {
      this.bump();
      void this.decide(confirm.id, answer === "yes");
      return;
    }
    this.submit(text, spoken);
  };

  submit(text: string, spoken = false) {
    if (!spoken) this.d.speaker.unlock?.(this.micOpen()); // a typed Send is a tap: unlock audio for the reply (iPhone Safari)
    if (!this.bridge && !this.awake) {
      this.awake = true;
      void this.startMic();
    }
    this.bump();
    this.patch({ interim: "" });
    // A turn is working on it: his words join that turn, never cancel it (owner: "dont cancel but add onto the prompt").
    // Not after a barge-in (that turn is over for him) or while a confirm waits (that is a yes or no).
    const tv = this.tv;
    if (this.turning && tv && !tv.silenced && !this.state.confirm) {
      const words = afterWakePhrase(text, this.state.settings.wakePhrase);
      if (words) this.addToTurn(tv, words, spoken);
      return;
    }
    void this.runTurn(text, spoken);
  }

  /** Shows the added line above the reply and sends it to the turn (held until the turn's id arrives). */
  private addToTurn(tv: TurnVoice, text: string, spoken: boolean) {
    const line: Message = { id: uid("a"), role: "user", text, added: true };
    const at = this.state.thread.findIndex((m) => m.id === tv.replyId);
    const thread = [...this.state.thread];
    thread.splice(at < 0 ? thread.length : at, 0, line);
    this.patch({ thread });
    if (tv.turnId) void this.sendAdded(tv, line.id, text, spoken);
    else tv.pending.push({ id: line.id, text });
  }

  /**
   * POST /api/agent/turn/append. 409: the turn ended first, so the words start the next turn instead. While its
   * stream is still open (the last text and done not read yet), they wait for it to end and go as one turn (runTurn's
   * finally), so the answer's tail is never cut and two refused additions never cancel each other.
   */
  private async sendAdded(tv: TurnVoice, lineId: string, text: string, spoken: boolean) {
    try {
      const res = await this.d.fetch("/api/agent/turn/append", { method: "POST", headers: json, body: JSON.stringify({ turnId: tv.turnId, text }) });
      if (res.ok) return;
      if (res.status === 409) {
        if (this.tv === tv && this.turning) {
          tv.pending.push({ id: lineId, text, spoken });
          return;
        }
        this.patch({ thread: this.state.thread.filter((m) => m.id !== lineId) });
        // A newer turn is already working: they join it, like any words said while it thinks.
        const cur = this.tv;
        if (this.turning && cur && !cur.silenced && !this.state.confirm) this.addToTurn(cur, text, spoken);
        else void this.runTurn(text, spoken);
        return;
      }
      this.patch({ error: errorOf(await res.json().catch(() => null), "That did not work") });
    } catch {
      this.patch({ error: "Could not reach Hydra" });
    }
  }

  /**
   * Answers the live confirm. The paused turn's stream stays open: the server resumes it and the result streams into
   * the same reply.
   */
  decide = async (id: string, approve: boolean) => {
    if (this.state.confirm?.id === id) this.patch({ confirm: null });
    this.sync();
    await this.post("/api/agent/confirm", { id, approve });
  };

  private surface(): ClientSurface {
    if (this.bridge) return "desktop";
    if (this.d.surface) return this.d.surface();
    return typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)").matches ? "phone" : "web";
  }

  private context() {
    const here = this.d.here?.() ?? (typeof window === "undefined" ? { path: "/", search: "" } : { path: window.location.pathname, search: window.location.search });
    return { path: here.path.slice(0, 500), search: here.search.slice(0, 2000), scope: scopeOf(here.search) };
  }

  private async runTurn(text: string, spoken: boolean) {
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    this.dropBargeHold();
    this.endVoice();
    this.d.speaker.stop();
    const reply: Message = { id: uid("h"), role: "hydra", text: "", parts: [] };
    this.patch({
      error: null,
      macIssue: null,
      confirm: null,
      thread: [...this.state.thread.filter(hasContent), { id: uid("u"), role: "user", text }, reply],
    });
    const tv: TurnVoice = {
      replyId: reply.id,
      seg: "",
      segIdx: null,
      segSaid: 0,
      grace: undefined,
      fillerTimer: undefined,
      answering: false,
      running: 0,
      fillers: 0,
      lastFillerAt: 0,
      silenced: false,
      turnId: null,
      pending: [],
    };
    this.tv = tv;
    this.said = [];
    this.turning = true;
    this.speaking = false;
    this.sync();

    if (!this.state.muted) {
      this.nextFiller = pickFiller(this.lastFiller, this.d.random);
      this.d.speaker.prefetch?.(this.nextFiller);
      tv.fillerTimer = setTimeout(() => this.tv === tv && this.filler("wait"), this.d.fillerMs ?? FILLER_MS);
    }
    const interruptedAfter = this.cutOff;
    this.cutOff = null;
    const body = {
      ...(this.threadId ? { threadId: this.threadId } : {}),
      input: spoken ? { audioTranscript: text } : { text },
      surface: this.surface(),
      context: this.context(),
      ...(interruptedAfter ? { interruptedAfter } : {}),
    };
    try {
      const res = await this.d.fetch("/api/agent/turn", { method: "POST", headers: json, body: JSON.stringify(body), signal: ac.signal });
      if (!res.ok || !res.body) {
        const out = await res.json().catch(() => null);
        throw new Error(errorOf(out, res.status === 503 ? "Hydra is not set up yet" : `The agent answered ${res.status}`));
      }
      for await (const ev of readTurnStream(res.body)) {
        if (ac.signal.aborted) break;
        if (this.tv !== tv) break;
        this.onEvent(ev, tv);
        // A spoken turn that failed (the Mac is offline, say) answers out loud too, not only on the card.
        if (ev.type === "error" && spoken && !this.state.muted && !tv.silenced) this.voice(ev.message);
        if (ev.type === "done") break;
      }
    } catch (e) {
      if (!ac.signal.aborted) this.patch({ error: (e as Error).message || "Could not reach Hydra" });
    } finally {
      if (this.abort === ac) {
        if (!ac.signal.aborted && this.tv === tv) this.release(true);
        this.endVoice();
        this.abort = null;
        this.turning = false;
        this.patch({ confirm: null, thread: this.state.thread.filter((m) => m.id !== reply.id || hasContent(m)) });
        this.sync();
        void this.refresh(); // the actions this turn took, with their undo ids
        // Words added before the turn had an id (it failed first, say) are never lost: they become the next turn.
        const held = tv.pending.splice(0);
        if (held.length && !ac.signal.aborted) {
          const ids = new Set(held.map((p) => p.id));
          this.patch({ thread: this.state.thread.filter((m) => !ids.has(m.id)) });
          void this.runTurn(held.map((p) => p.text).join("\n"), held.some((p) => p.spoken));
        }
      }
    }
  }

  /**
   * One event of the turn. Text streams into the open segment and is spoken sentence by sentence after a short grace.
   * A tool that starts turns the segment before it into a step (narration, never spoken) and adds its own step. Only
   * the answer is a text part.
   */
  private onEvent(ev: TurnEvent, tv: TurnVoice) {
    switch (ev.type) {
      case "thread":
        this.threadId = ev.threadId;
        if (this.state.threadId !== ev.threadId) this.patch({ threadId: ev.threadId });
        return;
      case "turn": {
        tv.turnId = ev.turnId;
        const held = tv.pending.splice(0);
        for (const p of held) void this.sendAdded(tv, p.id, p.text, false);
        return;
      }
      case "text": {
        tv.seg += ev.delta;
        const text = stripEmotes(tv.seg);
        this.patchReply(tv.replyId, (parts) => {
          if (tv.segIdx === null) tv.segIdx = parts.push({ kind: "text", text }) - 1;
          else parts[tv.segIdx] = { kind: "text", text };
          return parts;
        });
        // Wait a beat before speaking a finished sentence: a tool right after it makes it narration.
        if (tv.grace === undefined && takeSentences(text).sentences.length > tv.segSaid) tv.grace = setTimeout(() => this.release(false), this.d.stepGraceMs ?? STEP_GRACE_MS);
        return;
      }
      case "ui":
        this.exec(ev.action);
        return;
      case "tool": {
        // A step that ran after a confirm: the card is answered.
        if (ev.status !== "start" && this.state.confirm) this.patch({ confirm: null });
        if (ev.status === "error" && ev.summary) this.patch({ error: ev.summary });
        const label = ev.summary || ev.name;
        if (ev.status === "start") {
          // Narration only when none of it was said yet. A segment already spoken was the answer: it stays text, its
          // last sentence is said too, and no filler follows it.
          const spokenAnswer = tv.segSaid > 0;
          if (spokenAnswer) this.release(true);
          const narration = stripEmotes(tv.seg, true).trim();
          const idx = tv.segIdx;
          this.closeSegment();
          this.patchReply(tv.replyId, (parts) => {
            if (idx !== null) {
              if (!narration) parts.splice(idx, 1);
              else parts[idx] = spokenAnswer ? { kind: "text", text: narration } : { kind: "step", text: narration };
            }
            parts.push({ kind: "step", text: label, tool: ev.name, status: "running" });
            return parts;
          });
          tv.running++;
          if (!spokenAnswer) {
            tv.answering = false;
            this.filler("tool");
          }
        } else {
          const status = ev.status === "error" ? ("error" as const) : ("done" as const);
          this.patchReply(tv.replyId, (parts) => {
            for (let i = parts.length - 1; i >= 0; i--) {
              const p = parts[i];
              if (p.kind === "step" && p.tool === ev.name && p.status === "running") {
                parts[i] = { ...p, status, text: ev.summary || p.text };
                return parts;
              }
            }
            // A step reported only when done (no start): above the answer being written, if there is one.
            const step: MessagePart = { kind: "step", text: label, tool: ev.name, status };
            if (tv.segIdx === null) parts.push(step);
            else parts.splice(tv.segIdx++, 0, step);
            return parts;
          });
          if (tv.running > 0) tv.running--;
        }
        this.sync();
        return;
      }
      case "model": {
        // Who answered, as the reply's hover ("Grok 4.7 · High", or why it fell back).
        const model = answeredBy(ev, this.state.settings.model);
        this.patch({ thread: this.state.thread.map((m) => (m.id === tv.replyId ? { ...m, model } : m)) });
        return;
      }
      case "confirm":
        this.patch({ confirm: { id: ev.id, prompt: ev.summary, danger: ev.danger }, expanded: true, approvals: this.state.approvals.filter((a) => a.id !== ev.id) });
        this.leadIn(tv);
        this.sync(); // listening, so a spoken yes or no answers it
        return;
      case "error":
        this.patch({ error: ev.message, macIssue: (ev.code && MAC_ISSUES[ev.code]) || null });
        return;
      default:
        return;
    }
  }

  /**
   * The turn waits on the owner's yes: say the lead-in now. It is the text just before the confirm, or the narration
   * just before the gated tool started (then it was the question's lead-in, not narration: it becomes text).
   */
  private leadIn(tv: TurnVoice) {
    if (tv.seg.trim()) {
      this.release(true);
      this.closeSegment();
      return;
    }
    // Only the narration right before the gated tool's step (the last one): never an older tool's narration, and
    // never text, which was said already.
    const thread = this.state.thread.find((m) => m.id === tv.replyId);
    const parts = thread?.parts ?? [];
    const last = parts.length - 1;
    const i = last >= 0 && parts[last].kind === "step" && parts[last].tool ? last - 1 : last;
    const p = parts[i];
    if (!p || p.kind !== "step" || p.tool) return;
    this.patchReply(tv.replyId, (ps) => {
      ps[i] = { kind: "text", text: p.text };
      return ps;
    });
    const { sentences } = takeSentences(p.text, true);
    tv.answering = true;
    if (!this.state.muted && !tv.silenced) sentences.forEach((s) => this.voice(s));
  }

  private exec(ev: UiEvent) {
    (this.d.runUi ?? ((e) => runUi(e, this.d.nav)))(ev);
  }

  /* ---- panel: undo, routine approvals, thread ---- */
  /** Undo one action. True when it was undone; a failure also shows as the thread's error. */
  undo = async (actionId: string): Promise<boolean> => {
    const ok = await this.post("/api/agent/undo", { actionId, surface: this.surface() });
    if (ok) this.patch({ activity: this.state.activity.map((a) => (a.undoId === actionId ? { ...a, undone: true, undoId: null } : a)) });
    void this.refresh();
    return ok;
  };

  /** Approve or decline an approval a routine or an MCP client left. */
  decideApproval = async (id: string, approve: boolean) => {
    const ok = await this.post("/api/agent/confirm", { id, approve });
    if (ok) this.patch({ approvals: this.state.approvals.filter((a) => a.id !== id) });
  };

  private post(url: string, body: object): Promise<boolean> {
    return this.send("POST", url, body);
  }

  private async send(method: "POST" | "PATCH", url: string, body: object): Promise<boolean> {
    try {
      const res = await this.d.fetch(url, { method, headers: json, body: JSON.stringify(body) });
      const out: unknown = await res.json().catch(() => null);
      if (res.ok && !(isObj(out) && out.ok === false)) return true;
      this.patch({ error: errorOf(out, "That did not work") });
    } catch {
      this.patch({ error: "Could not reach Hydra" });
    }
    return false;
  }

  /**
   * Loads the shared thread (its id and, when this window shows nothing yet, its messages), the activity list, the
   * approvals waiting and the sleep word. A missing server leaves the panel as it is.
   */
  refresh = async (reloadThread = false) => {
    try {
      const res = await this.d.fetch("/api/agent/state");
      if (!res.ok) return;
      const s: unknown = await res.json();
      if (!isObj(s)) return;
      const live = liveThread(s.threads);
      // A relay turn's confirm is also an approval row: it belongs to its confirm card, not the list.
      const approvals = Array.isArray(s.pendingApprovals) ? toApprovals(s.pendingApprovals).filter((a) => a.id !== this.state.confirm?.id) : this.state.approvals;
      const p: Partial<AgentState> = { activity: Array.isArray(s.activity) ? toActivity(s.activity) : this.state.activity, approvals };
      // The attached Mac waits on a yes while it works: open the panel on a new one.
      if (this.bridge && this.desktopState === "thinking" && approvals.some((a) => !this.state.approvals.some((b) => b.id === a.id))) p.expanded = true;
      if (live && (!this.threadId || this.threadId === live.id)) {
        this.threadId = live.id;
        p.threadId = live.id;
        if (!this.turning && (reloadThread || this.state.thread.length === 0)) p.thread = toMessages(live.messages);
      }
      const word = isObj(s.settings) && isStr(s.settings.sleepWord) ? s.settings.sleepWord.trim() : "";
      if (word) p.sleepWord = word;
      const voice = voiceSettingsOf(s.settings, this.state.settings);
      if (voice) p.settings = voice;
      if (Array.isArray(s.avatars)) p.avatars = s.avatars.filter(isObj).flatMap((a) => (isStr(a.id) && isStr(a.name) ? [{ id: a.id, name: a.name }] : []));
      if (isObj(s.settings) && (isStr(s.settings.activeAvatarId) || s.settings.activeAvatarId === null)) p.activeAvatarId = s.settings.activeAvatarId;
      if (Array.isArray(s.providers)) p.providers = readProviders(s.providers);
      // A new voice (another avatar, or its voice id edited): fillers said in the old one are not replayed.
      if ("activeAvatar" in s) {
        const voiceId = isObj(s.activeAvatar) && isStr(s.activeAvatar.voiceId) ? s.activeAvatar.voiceId : null;
        if (this.voiceId !== undefined && voiceId !== this.voiceId) this.d.speaker.forget?.();
        this.voiceId = voiceId;
      }
      this.patch(p);
      if (word) void this.moveLegacySleepWord(word);
    } catch {
      /* offline */
    }
  };

  /** Once: a sleep word an older client kept on this device goes to the server, if the server still has the default. */
  private async moveLegacySleepWord(server: string) {
    let local: string | undefined;
    try {
      const store = this.d.storage ?? localStore();
      local = store?.getItem(LEGACY_SLEEP_WORD_KEY)?.trim();
      store?.removeItem(LEGACY_SLEEP_WORD_KEY);
    } catch {
      return; /* private mode: nothing kept */
    }
    if (local && server === DEFAULT_SLEEP_WORD && local !== server) await this.setSleepWord(local);
  }

  /** The thread the next turn continues (tests and the e2e read it). */
  get currentThread() {
    return this.threadId;
  }
}

export function defaultDeps(nav: Nav, speaker: SpeakerLike, extra: Partial<ControllerDeps> = {}): ControllerDeps {
  return {
    fetch: (...a) => fetch(...a),
    nav,
    speaker,
    createListener: defaultCreateListener,
    openMic: defaultOpenMic,
    blip: defaultBlip,
    supported: speechSupported,
    ...extra,
  };
}
