import { asDevice, json } from "@/lib/agent/caller";
import { RATE_LIMITS } from "@/lib/agent/devices";
import { RELAY_LEASE_S, slotSchema, supabaseRelay, threadHistory, turnOut } from "@/lib/agent/relay";
import { CAPABILITIES_HEADER, capabilitiesSchema } from "@/lib/agent/relay-schema";
import { supabaseStore } from "@/lib/agent/store";

/**
 * GET /api/agent/relay/next?wait=25&slot=live|routine (Hydra Desktop, device key with scope "relay"):
 * long-poll for the next queued turn of that slot (live: web, phone, desktop; routine; no slot:
 * either). Claims the oldest one for this device under a 60 s lease and a fresh claim id (one device
 * wins) and answers {turn: {id, claimId, threadId, input, surface, context, history, routineId?,
 * routineRunId?, allowedTools?, avatar?, style?}} (style: the active avatar's, 0220), or 204 when nothing came within `wait` seconds (0-25). Each claim
 * counts as the Mac's relay loop being seen: that is what "the Mac is online" means. The Mac's HTTP
 * timeout must sit well above `wait`; a client that left is never handed a turn. Each poll records what the Mac
 * declared in CAPABILITIES_HEADER (0200; none from an older Mac clears it), which mac_do reads under approve all.
 */
export const maxDuration = 60;

const MAX_WAIT_S = 25;
const POLL_MS = 500;

export async function GET(request: Request) {
  return asDevice(request, "relay", RATE_LIMITS.deviceRelay, async (device, admin) => {
    const params = new URL(request.url).searchParams;
    const slot = params.has("slot") ? slotSchema.safeParse(params.get("slot")) : null;
    if (slot && !slot.success) return json({ error: "invalid_input", message: "slot is live or routine" }, 400);
    const asked = Number(params.get("wait") ?? 0);
    const until = Date.now() + Math.min(Math.max(Number.isFinite(asked) ? asked : 0, 0), MAX_WAIT_S) * 1000;
    const relay = supabaseRelay(admin);
    const store = supabaseStore(admin);
    await store.setCapabilities(device.id, capabilitiesSchema.parse(request.headers.get(CAPABILITIES_HEADER)));
    for (;;) {
      if (request.signal.aborted) return new Response(null, { status: 204 });
      const turn = await relay.claim(device.id, RELAY_LEASE_S, slot?.data ?? null);
      if (turn) {
        const [routineId, history, settings] = await Promise.all([
          turn.routine_run_id ? relay.routineOfRun(turn.routine_run_id) : null,
          threadHistory(store, turn.thread_id),
          store.settings(),
        ]);
        return json({ turn: turnOut(turn, routineId, history, settings.activeAvatar) });
      }
      if (Date.now() >= until) return new Response(null, { status: 204 });
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  });
}
