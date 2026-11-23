import { z } from "zod";
import { asOwner, json, readJson } from "@/lib/agent/caller";
import { createModelClient, LIVE_GROUPS, NOT_CONFIGURED } from "@/lib/agent/config";
import { eventStream, scopeSchema, SURFACES } from "@/lib/agent/events";
import { runTurn } from "@/lib/agent/loop";
import { relayTurn, supabaseRelay } from "@/lib/agent/relay";
import { supabaseStore } from "@/lib/agent/store";

/**
 * POST /api/agent/turn: one Hydra Agent turn, streamed as text/event-stream (W2 brief contract).
 * Owner session, or a paired device key (scope "agent") through the owner-session bridge.
 * A gated step pauses the stream at a `confirm` event until /api/agent/confirm answers it.
 * The brain (agent_settings.brain): 'mac' (default) relays the turn to Hydra Desktop and streams its
 * events (the server brain when online, else the Mac; neither online: error brain_offline); 'server' runs the server loop (needs ANTHROPIC_API_KEY).
 */
export const maxDuration = 300;

const bodySchema = z.object({
  threadId: z.uuid().optional(),
  input: z.union([z.object({ text: z.string().trim().min(1).max(8000) }), z.object({ audioTranscript: z.string().trim().min(1).max(8000) })]),
  surface: z.enum(SURFACES),
  context: z
    .object({ path: z.string().max(500), search: z.string().max(2000), scope: scopeSchema })
    .default({ path: "/", search: "", scope: "all" }),
  /** The owner cut Hydra off: what it had said by then, so the answer picks up from there. */
  interruptedAfter: z.string().trim().min(1).max(4000).optional(),
});

export async function POST(request: Request) {
  const startedAt = Date.now(); // the turn's time budget counts from here (maxDuration does)
  return asOwner(request, "agent", async (caller) => {
    const body = bodySchema.safeParse(await readJson(request));
    if (!body.success) return json({ error: "invalid_input", message: z.prettifyError(body.error) }, 400);
    const store = supabaseStore(caller.db);
    const settings = await store.settings();
    const { input, surface, threadId, interruptedAfter } = body.data;
    // The relay brain gets it in the turn's context (jsonb, additive); the server loop's context block says it.
    const context = interruptedAfter ? { ...body.data.context, interruptedAfter } : body.data.context;
    if (settings.brain === "mac") {
      const relay = supabaseRelay(caller.db);
      return eventStream((emit, signal) => relayTurn({ relay, store, surface, threadId, input, context, emit, signal, startedAt }));
    }
    const client = createModelClient();
    if (!client) return json(NOT_CONFIGURED, 503);
    return eventStream((emit, signal) =>
      runTurn({
        client,
        store,
        ctx: {
          db: caller.db,
          surface,
          runId: null,
          deviceId: caller.deviceId,
          unattended: false,
          allowed: LIVE_GROUPS,
          now: () => new Date(),
          timeZone: () => store.timeZone(),
        },
        threadId,
        text: "text" in input ? input.text : input.audioTranscript,
        page: context,
        emit,
        signal,
        mode: "live",
        settings,
        startedAt,
      }).then(() => undefined),
    );
  });
}
