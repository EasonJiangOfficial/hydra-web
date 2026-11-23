import type { AgentController, AgentState } from "@/components/agent/controller";
import type { MessagePart } from "@/components/agent/types";

/*
 * Panel states for the fixture (`/dev/agent?panel=<name>`, or window.__agentPreset(name) from e2e): every state the
 * panel draws, written straight into the controller's store in the shape the voice controller makes them
 * (parts, phase, filler, wakePhrase).
 */
type Preset = Partial<AgentState>;

const ask = { id: "p-u1", role: "user" as const, text: "What did I earn this week?" };
const steps: MessagePart[] = [
  { kind: "step", text: "I need dates; today is 2026-11-22.", status: "done" },
  { kind: "step", text: "Looked at 14 posts from Nov 16 to Nov 22", tool: "ugc_posts", status: "done" },
];
const answer = "You've earned $3,525 this week across 14 videos. Tuesday was the best day, $910 from the Wordwise deal.";

export const PANEL_PRESETS: Record<string, Preset> = {
  thinking: { status: "thinking", phase: "thinking", filler: null, thread: [ask, { id: "p-h1", role: "hydra", text: "", parts: [] }] },
  checking: {
    status: "thinking",
    phase: "checking",
    filler: "Let me check that.",
    thread: [ask, { id: "p-h1", role: "hydra", text: "", parts: [steps[0], { kind: "step", text: "Adding up pay per video", tool: "ugc_earnings", status: "running" }] }],
  },
  filler: { status: "speaking", phase: "thinking", filler: "Let me see.", thread: [ask, { id: "p-h1", role: "hydra", text: "", parts: [] }] },
  streaming: {
    status: "speaking",
    phase: "speaking",
    filler: null,
    thread: [ask, { id: "p-h1", role: "hydra", text: answer.slice(0, 64), parts: [...steps, { kind: "text", text: answer.slice(0, 64) }] }],
  },
  answered: {
    status: "listening",
    phase: "idle",
    thread: [
      { id: "p-u0", role: "user", text: "Goodnight" },
      { id: "p-h0", role: "hydra", text: "[wave] Goodnight, sir." },
      ask,
      { id: "p-h1", role: "hydra", text: answer, parts: [...steps, { kind: "text", text: answer }] },
    ],
  },
  confirm: {
    status: "listening",
    phase: "idle",
    thread: [{ id: "p-u1", role: "user", text: "Delete the Costco charge" }, { id: "p-h1", role: "hydra", text: "That deletes one transaction." }],
    confirm: { id: "00000000-0000-4000-8000-00000000c0ff", prompt: "Delete the Costco transaction of $84.12 from Nov 3?", danger: true },
  },
  error: { status: "listening", phase: "idle", thread: [ask], error: "Could not reach Hydra" },
  offline: { status: "listening", phase: "idle", thread: [ask], error: "Hydra is offline.", macIssue: "brain_offline" },
  wake: { status: "listening", phase: "idle", wakePhrase: true, thread: [] },
};

/** Writes a preset into the controller (the fixture only; `patch` is the store's own setter). */
export function applyPanelPreset(ctl: AgentController, name: string): boolean {
  const p = PANEL_PRESETS[name];
  if (!p) return false;
  (ctl as unknown as { patch(p: Preset): void }).patch({ expanded: true, approvals: [], error: null, macIssue: null, confirm: null, ...p });
  return true;
}
