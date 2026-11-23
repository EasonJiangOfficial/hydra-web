/**
 * The Hydra Agent client side of the W2 contract. The server (`src/lib/agent/events.ts`, `src/app/api/agent/*`) owns
 * the shapes; this file imports them so a drift fails the type check.
 *
 *   POST /api/agent/turn    { threadId?, input: { text } | { audioTranscript }, surface, context: { path, search, scope } }
 *                           -> text/event-stream, one AgentEvent per `data:` frame
 *   POST /api/agent/confirm { id, approve }      the answer to a live confirm or a routine/MCP approval
 *   GET  /api/agent/state   -> { threads, pendingApprovals, activity: [{ id, summary, undoId, undoneAt, ... }], notifications }
 *   POST /api/agent/undo    { actionId }
 *   POST /api/voice/tts     { text } -> audio/mpeg stream, or 503 { error: "voice_not_configured" }
 */
import type { AgentEvent, ClientSurface, Scope, UiAction } from "@/lib/agent/events";

export { PANEL_PARAMS, SCOPES, scopeSchema, type PanelParam } from "@/lib/agent/events";
export type { ClientSurface, Scope };

export type AgentStatus = "asleep" | "listening" | "thinking" | "speaking";

export const STATUS_LABEL: Record<AgentStatus, string> = {
  asleep: "Asleep",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

/** Interface steps the agent asks this window to run (the server's UiAction). */
export type UiEvent = UiAction;
/**
 * One event of a turn's stream, after validation (the server's AgentEvent; `done` drops usage). `error` may carry a
 * code: `brain_offline` when neither Hydra's server nor the Mac is online (`mac_offline` from an older server),
 * `mac_timeout` when it never answered (W3 relay contract).
 */
export type TurnEvent = Exclude<AgentEvent, { type: "done" } | { type: "error" }> | { type: "done" } | { type: "error"; message: string; code?: string };

/**
 * One piece of a Hydra reply. `text` is the spoken answer (emote tags such as [wave] stripped); `step` is a tool run or
 * the narration the model wrote before it ("I need dates; today ..."), shown as a small "checking" line and never spoken.
 */
export type MessagePart = { kind: "text"; text: string } | { kind: "step"; text: string; tool?: string; status?: "running" | "done" | "error" };
/** `text` is the reply's answer (its text parts joined), so a reader that ignores `parts` still shows the right words. */
export type Message = {
  id: string;
  role: "user" | "hydra";
  text: string;
  parts?: MessagePart[];
  /** The owner's words added to the turn in flight (0191): shown as an added line, not a new question. */
  added?: boolean;
  /** Hydra's reply: who answered (the model event), its hover ("Grok 4.7 · High"). */
  model?: string;
};
/** What the agent is doing, for the thinking animation: working, running a tool, or saying its answer. */
export type AgentPhase = "idle" | "thinking" | "checking" | "speaking";
/**
 * One row of the activity list. `undoId` is set while the action can still be undone. `threadId` (the conversation it
 * ran in), `createdAt` and `surface` group it and show on hover; null from an older server.
 */
export type Activity = { id: string; label: string; undoId: string | null; undone: boolean; createdAt: string | null; threadId: string | null; surface: string | null };
/** A pending approval from an unattended routine or an MCP client. */
export type Approval = { id: string; prompt: string };
export type Confirm = { id: string; prompt: string; danger: boolean };

export type DesktopState = "Asleep" | "Listening" | "Thinking" | "Speaking";
export type Perm = "granted" | "denied" | "not_determined";
export type PermKind = "mic" | "accessibility" | "screen";

/** What Hydra Desktop pushes (snapshot() and subscribe()). Fields past the v1 three are optional: older desktops leave them out. */
export type DesktopSnapshot = {
  state: DesktopState;
  micLevel: number;
  outputLevel: number;
  /** v2: the orb floats on the Mac desktop instead of living in this window. */
  detached?: boolean;
  /** v3 */
  muted?: boolean;
  paused?: boolean;
  /** v3: the Mac agent's current spoken reply, streamed. */
  reply?: { id: string; text: string; final: boolean } | null;
  /** v3: the owner's words as the Mac heard them. */
  heard?: { text: string; final: boolean } | null;
  /** "phrase" when the Mac only listens for "Hey Hydra" (newer desktops; older ones never send it). */
  wake?: string;
  /** v3: an interface step from the Mac agent. Untrusted (model output): validated before it runs. */
  ui?: unknown;
  /** W5 section 5: 24 spectrum bands 0..1 (Hydra's voice while speaking, the mic while listening). Newer desktops only. */
  bands?: number[];
  /**
   * The last wake on a double clap or the wake phrase (`at`: the desktop's Date.now()). The bridge repeats the last
   * snapshot, so it stays until the next wake: the web dedupes on `at`. Newer desktops only; never on a web or menu wake.
   */
  woke?: Woke;
};
export type Woke = { at: number; from: "clap" | "phrase" };

/** v3 setup() result. */
export type DesktopSetup = {
  paired: boolean;
  claude: "signed_in" | "signed_out";
  permissions: Record<PermKind, Perm>;
  version: string;
};
export type BridgeResult = { ok: true } | { ok: false; error?: string };

/**
 * Hydra Desktop's bridge (`window.hydraDesktop`, HydraDesktop docs/BRIDGE.md and W3 bridge v3). When it exists, the
 * desktop owns the microphone and the voice: this window mirrors its state and levels, forwards the card's controls,
 * and runs the interface steps it sends. v1 has only the first block; v2 adds detach/attach; v3 the rest. Every
 * optional method is feature-detected, so an older desktop keeps working. Built from the raw object only by
 * desktopBridge() in desktop.ts, which guards every read and call.
 */
export type HydraDesktopBridge = {
  version: number;
  readonly state: DesktopState;
  readonly micLevel: number;
  readonly outputLevel: number;
  snapshot(): DesktopSnapshot;
  /** Called at once, then on every change. Returns the unsubscribe. */
  subscribe(fn: (s: DesktopSnapshot) => void): () => void;
  wake(): void;
  sleep(): void;
  /* v2 */
  readonly detached?: boolean;
  detach?(): void;
  attach?(): void;
  /* v3: voice controls */
  stop?(): void;
  pause?(): void;
  resume?(): void;
  setMuted?(muted: boolean): void;
  /* v3: setup */
  setup?(): Promise<DesktopSetup>;
  pair?(code: string): Promise<BridgeResult>;
  signInClaude?(): Promise<BridgeResult>;
  requestPermission?(kind: PermKind): Promise<Perm>;
  unpair?(): Promise<void>;
};

declare global {
  interface Window {
    /** Hydra Desktop's native object (its docs/BRIDGE.md). Untyped on purpose: read it only through desktopBridge(). */
    hydraDesktop?: unknown;
  }
}
