import { z } from "zod";
import { asDevice, json, readJson } from "@/lib/agent/caller";
import { liveChannels } from "@/lib/agent/channels";
import { finishRelayRun } from "@/lib/agent/cron";
import { RATE_LIMITS } from "@/lib/agent/devices";
import { BRAIN_FAILED, RELAY_LEASE_S, relayBatchSchema, supabaseRelay } from "@/lib/agent/relay";
import { supabaseStore } from "@/lib/agent/store";

/**
 * POST /api/agent/relay/events {turnId, claimId, seq?, events} (Hydra Desktop, scope "relay"): the
 * Mac's events for a turn it holds under that claim, exactly as the SSE contract (text, tool, ui,
 * confirm, done, error; done or error last; shapes in relay-schema.ts). Stored in order, the lease
 * renews (an empty list is the heartbeat), done or error closes the turn (the owner's words and the
 * reply go into the thread). seq dedupes a retried post. A confirm names an approval of this Mac:
 * one its MCP gate made, or a relay approval of this turn. A routine's turn, once closed, ends its run.
 *
 * The answer carries `inputs: [{seq, text}]`: what the owner added while the turn runs (0191), past `inputsSeen`.
 * A post without `inputsSeen` (an older device) gets none, and the turn takes none while that claim holds it.
 * A done that arrives while some wait past what the device acknowledged is held: the answer is status "claimed" with
 * them (the done counts toward seq but is not stored); the device answers them and sends done again.
 *
 * 400 invalid_input / unknown_approval, 403 not_yours, 404 not_found, 409 stale_claim (the turn was
 * re-queued, expired or closed: stop running it) or seq_gap. The Mac never retries a 4xx.
 */
export async function POST(request: Request) {
  return asDevice(request, "relay", RATE_LIMITS.deviceRelay, async (device, admin) => {
    const body = relayBatchSchema.safeParse(await readJson(request));
    if (!body.success) return json({ error: "invalid_input", message: z.prettifyError(body.error) }, 400);
    const { turnId, claimId, seq, events, inputsSeen } = body.data;
    const store = supabaseStore(admin);
    for (const e of events) {
      if (e.type !== "confirm") continue;
      const approval = await store.getApproval(e.id);
      const mine =
        approval?.device_id === device.id &&
        (approval.source === "mcp" || (approval.source === "relay" && approval.relay_turn_id === turnId));
      if (!mine) return json({ error: "unknown_approval", id: e.id }, 400);
    }
    const relay = supabaseRelay(admin);
    // The same relay client runs on the server brain: its "the Mac could not finish" is Hydra's (0121).
    const last = events.at(-1);
    if (last?.type === "error" && last.code === "mac_failed" && (await relay.deviceRole(device.id)) === "brain") events[events.length - 1] = { ...BRAIN_FAILED };
    // 0191: a done is held while additions the device has not read wait (the turn stays claimed and the answer carries
    // them), so its inputsSeen is acknowledged before the append checks.
    if (last?.type === "done" && inputsSeen !== undefined) await relay.inputsAck(turnId, device.id, claimId, inputsSeen);
    const status = await relay.append(turnId, device.id, claimId, seq ?? null, events, RELAY_LEASE_S);
    if (status === "not_found") return json({ error: "not_found" }, 404);
    if (status === "not_yours") return json({ error: "not_yours" }, 403);
    if (status === "stale_claim" || status === "seq_gap") return json({ error: status }, 409);
    if (status === "done" || status === "error") {
      const turn = await relay.getTurn(turnId);
      if (turn?.routine_run_id) await finishRelayRun(store, relay, turn, liveChannels());
      return json({ ok: true, status, inputs: [] });
    }
    // 0191: the owner's additions this device has not pushed into its session yet. Only a device that sends
    // inputsSeen (even 0) reads them; until it does, the turn takes none (an older Mac would ignore them).
    const inputs = inputsSeen === undefined ? [] : await relay.inputsAck(turnId, device.id, claimId, inputsSeen);
    return json({ ok: true, status, inputs });
  });
}
