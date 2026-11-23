import type { BetaContentBlock, BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModelClient } from "./loop";
import type { ToolCtx, ToolGroup } from "./registry";
import type { AgentStore } from "./store";

/** Test fixtures (not imported by app code): a scripted model and a tool context. */

export interface Step {
  text?: string;
  content: BetaContentBlock[];
  stop_reason: BetaMessage["stop_reason"];
}

export const textBlock = (text: string): BetaContentBlock => ({ type: "text", text, citations: null }) as BetaContentBlock;
export const toolUse = (id: string, name: string, input: unknown): BetaContentBlock =>
  ({ type: "tool_use", id, name, input, caller: { type: "direct" } }) as unknown as BetaContentBlock;

/** A Messages API stand-in: answers each request with the next scripted step. */
export function scriptedModel(steps: (Step | ((params: BetaMessageStreamParams) => Step))[]) {
  const requests: BetaMessageStreamParams[] = [];
  const client: ModelClient = {
    beta: {
      messages: {
        stream(params) {
          requests.push(structuredClone(params));
          const next = steps[requests.length - 1];
          if (!next) throw new Error(`no scripted step ${requests.length}`);
          const step = typeof next === "function" ? next(params) : next;
          let onText: ((delta: string) => void) | undefined;
          return {
            on(_event: "text", listener: (delta: string) => void) {
              onText = listener;
              return this;
            },
            async finalMessage() {
              if (step.text) onText?.(step.text);
              return {
                id: `msg_${requests.length}`,
                type: "message",
                role: "assistant",
                model: params.model,
                content: step.text ? [textBlock(step.text), ...step.content] : step.content,
                stop_reason: step.stop_reason,
                stop_sequence: null,
                stop_details: null,
                usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
              } as unknown as BetaMessage;
            },
          };
        },
      },
    },
  };
  return { client, requests };
}

export const ALL: ReadonlySet<ToolGroup> = new Set(["hydra", "routines", "memory", "ui", "mac", "gmail", "calendar"]);

export function toolCtx(store: AgentStore, over: Partial<ToolCtx> = {}): ToolCtx {
  return {
    store,
    db: {} as SupabaseClient,
    surface: "web",
    threadId: null,
    runId: null,
    deviceId: null,
    unattended: false,
    allowed: ALL,
    now: () => new Date("2026-11-21T15:00:00Z"),
    timeZone: async () => "America/Toronto",
    ui: () => {},
    ...over,
  };
}
