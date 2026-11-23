import type { ThreadMessageLike } from "@assistant-ui/react";
import type { AgentState } from "../controller";
import type { AgentPhase, Message, MessagePart } from "../types";

/*
 * The panel's read of the VOICE contract (types.ts MessagePart/AgentPhase, controller.ts phase/filler/wakePhrase).
 * Reads stay defensive: a stored thread or a desktop mirror can still carry odd parts, and an older state has no phase.
 */
export type StepStatus = NonNullable<Extract<MessagePart, { kind: "step" }>["status"]>;
export type Part = MessagePart;
export type Phase = AgentPhase;

const PHASES: readonly string[] = ["idle", "thinking", "checking", "speaking"];
const STATUSES: readonly string[] = ["running", "done", "error"];

/** Emote tags the model writes for the voice ("[wave] Goodnight."): never shown. A markdown link "[x](url)" stays. */
export const stripEmotes = (t: string) => t.replace(/\[[a-z][a-z _'-]{0,30}\](?!\()\s*/gi, "");

function toPart(p: unknown): Part | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  if (typeof o.text !== "string") return null;
  if (o.kind === "text") return { kind: "text", text: stripEmotes(o.text) };
  if (o.kind !== "step") return null;
  return {
    kind: "step",
    text: o.text,
    ...(typeof o.tool === "string" ? { tool: o.tool } : {}),
    ...(typeof o.status === "string" && STATUSES.includes(o.status) ? { status: o.status as StepStatus } : {}),
  };
}

/** A message's parts; a message with no parts is one text part. */
export function partsOf(m: Message): Part[] {
  const raw: unknown = m.parts;
  if (Array.isArray(raw) && raw.length) return raw.flatMap((p) => toPart(p) ?? []).filter((p) => p.kind === "step" || p.text !== "");
  const text = stripEmotes(m.text);
  return text ? [{ kind: "text", text }] : [];
}

/**
 * What Hydra is doing, for the working line. The controller keeps phase "thinking" until the voice starts (all turn
 * when muted), so once the answer's words show, the dots go: the streaming text is the progress.
 */
export function phaseOf(s: AgentState): Phase {
  const last = s.thread.at(-1);
  const reply = s.status === "thinking" && last?.role === "hydra" ? partsOf(last) : null;
  const p = s.phase;
  if (typeof p === "string" && PHASES.includes(p)) return (p === "thinking" || p === "checking") && reply?.some((x) => x.kind === "text") ? "idle" : p;
  if (s.status === "speaking") return "speaking";
  return reply?.length === 0 ? "thinking" : "idle";
}

export const fillerOf = (s: AgentState) => {
  const f = s.filler;
  return typeof f === "string" && f.trim() ? stripEmotes(f.trim()) : null;
};

/** The status word: Say "<wake phrase>" instead of Listening when the Mac listens for its wake phrase only. */
export function statusWord(s: AgentState, label: string): string {
  return s.status === "listening" && s.wakePhrase === true ? `Say “${s.settings?.wakePhrase || "Hey Hydra"}”` : label;
}

/** Hydra's message for assistant-ui's external store: text parts and `data-step` parts. Empty replies drop out. */
export function toThreadMessage(m: Message): ThreadMessageLike {
  if (m.role === "user")
    return { id: m.id, role: "user", content: [{ type: "text", text: m.text }], ...(m.added ? { metadata: { custom: { added: true } } } : {}) };
  return {
    id: m.id,
    role: "assistant",
    ...(m.model ? { metadata: { custom: { model: m.model } } } : {}),
    content: partsOf(m).map((p, i) =>
      p.kind === "text" ? { type: "text" as const, text: p.text } : { type: "data-step" as const, id: `${m.id}-s${i}`, data: { text: p.text, tool: p.tool ?? null, status: p.status ?? "done" } },
    ),
  };
}
