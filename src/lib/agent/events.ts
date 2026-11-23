/**
 * The wire contract of the Hydra Agent (W2 brief, "Hydra Agent contract"). The turn route streams
 * these as `text/event-stream`, one JSON object per `data:` line. U13b's interface reads them.
 */
// The scopes and panel params are the relay's shared list (relay-schema.ts, copied by Hydra Desktop).
import type { Effort, ModelFallback } from "./models";
import { PANEL_PARAMS, SCOPES, scopeSchema } from "./relay-schema";

export const SURFACES = ["web", "phone", "desktop"] as const;
export type ClientSurface = (typeof SURFACES)[number];
/** Where a thread, message or action came from. routine and mcp never start a live turn. */
export type Surface = ClientSurface | "routine" | "mcp";

export { PANEL_PARAMS, SCOPES };
export { scopeSchema };
/** "all" or an entity slug. */
export type Scope = string;
/** The URL params the shared kit DetailDrawer reads (DESIGN.md section 7). */
export type PanelParam = (typeof PANEL_PARAMS)[number];

export type UiAction =
  | { kind: "navigate"; href: string }
  | { kind: "openPanel"; param: PanelParam; value: string }
  | { kind: "setScope"; scope: Scope }
  | { kind: "highlight"; selector: string };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export type AgentEvent =
  | { type: "thread"; threadId: string }
  /** The turn in flight (0191): POST /api/agent/turn/append {turnId, text} adds the owner's words to it. Older clients ignore it. */
  | { type: "turn"; turnId: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; status: "start" | "done" | "error"; summary: string }
  | { type: "ui"; action: UiAction }
  | { type: "confirm"; id: string; summary: string; danger: boolean }
  /** Who answered (models.ts), once per turn; fallback says why it is not the model picked. Older clients ignore it. */
  | { type: "model"; model: string; effort: Effort; fallback?: ModelFallback }
  | { type: "done"; usage: Usage }
  | { type: "error"; message: string; code?: string };

export type Emit = (event: AgentEvent) => void;

/**
 * A Response that streams the events `run` emits. The stream closes when `run` settles; a throw
 * becomes one `error` event. `signal` fires when the client goes away.
 */
export function eventStream(run: (emit: Emit, signal: AbortSignal) => Promise<void>, headers: HeadersInit = {}): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit: Emit = (event) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          open = false;
        }
      };
      try {
        await run(emit, abort.signal);
      } catch (error) {
        console.error(`[agent] ${(error as Error).message}`);
        emit({ type: "error", message: "Something went wrong" });
      }
      open = false;
      try {
        controller.close();
      } catch {
        // already closed by a cancel
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      ...headers,
    },
  });
}
