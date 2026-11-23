import { z } from "zod";
import { asDevice, json, readJson } from "@/lib/agent/caller";
import { RATE_LIMITS } from "@/lib/agent/devices";
import { macDeletes } from "@/lib/agent/registry";
import { approvalStatus, RELAY_APPROVAL_LIVE_MS, RELAY_APPROVAL_ROUTINE_MS, relayApprovalSchema, supabaseRelay } from "@/lib/agent/relay";
import { CAPABILITIES_HEADER, capabilitiesSchema } from "@/lib/agent/relay-schema";
import { supabaseStore } from "@/lib/agent/store";

/**
 * Approvals for asks the Mac would show locally (Hydra Desktop, scope "relay").
 *
 * POST {turnId, claimId, summary, danger, deletion?}: in a relay turn the Mac holds, an ask it would show on
 * the Mac (a connector send or trash, a Mac tool, a risky click) becomes the owner's approval instead
 * (agent_approvals source 'relay'; a routine's waits up to 24 h, a live one 15 min). Answers 201 {id};
 * the Mac emits `confirm {id, summary, danger}` and polls GET until the owner answers on any surface.
 * 409 stale_claim when the turn is not this claim's any more. With approve all on (0200), the Mac is the source of
 * truth for what deletes: only when this request declares approveAllDeletionTags (CAPABILITIES_HEADER) and the ask
 * carries deletion false, danger false and no deletion words, the row is made under the same lock and approved before
 * the answer, 201 {id, status: "approved"}: the Mac goes on without an ask. Anything else (an older Mac, a missing
 * deletion, a deletion, a send, a pay, a deletion word) waits for the owner as before.
 *
 * GET ?id=: {status: pending | approved | declined | expired} for an approval this Mac's MCP gate or
 * relay turn made, so it goes on once the owner answered (POST /api/agent/confirm).
 */
export async function POST(request: Request) {
  return asDevice(request, "relay", RATE_LIMITS.deviceRelay, async (device, admin) => {
    const body = relayApprovalSchema.safeParse(await readJson(request));
    if (!body.success) return json({ error: "invalid_input", message: z.prettifyError(body.error) }, 400);
    const { turnId, claimId, summary, danger, deletion } = body.data;
    const relay = supabaseRelay(admin);
    const turn = await relay.getTurn(turnId);
    if (!turn) return json({ error: "not_found" }, 404);
    if (turn.claim_id !== claimId || turn.status !== "claimed") return json({ error: "stale_claim" }, 409);
    if (turn.claimed_by !== device.id) return json({ error: "not_yours" }, 403);
    // The check above names the refusal; the row itself is made under the turn's lock, only while this
    // claim still holds it open, so no approval outlives its turn.
    const expiresAt = new Date(Date.now() + (turn.routine_run_id ? RELAY_APPROVAL_ROUTINE_MS : RELAY_APPROVAL_LIVE_MS)).toISOString();
    const store = supabaseStore(admin);
    // Approve all is read once per ask. The reason here is always "mac": the Mac's own tags decide (a declared
    // capability, deletion false, danger false); the words are an extra layer that can only add an ask.
    const tags = capabilitiesSchema.parse(request.headers.get(CAPABILITIES_HEADER)).approveAllDeletionTags === 1;
    const auto = tags && deletion === false && !danger && !macDeletes(summary) && (await store.settings()).approveAll;
    const approval = await relay.createApproval(turnId, device.id, claimId, { summary, danger, expiresAt });
    if (!approval) return json({ error: "stale_claim" }, 409);
    if (auto) {
      // pending -> approved, a compare-and-set: a close of the turn in between (0120 trigger) expires it first, and
      // then this is a stale claim. A death in between leaves a pending ask the Mac never got the id of: it fails closed.
      if (!(await store.moveApproval(approval.id, ["pending"], "approved"))) return json({ error: "stale_claim" }, 409);
      return json({ id: approval.id, status: "approved" }, 201);
    }
    await store.notify({ kind: "approval", title: "Hydra needs your yes", body: summary, href: null, dedupe_key: `approval:${approval.id}` });
    return json({ id: approval.id }, 201);
  });
}

export async function GET(request: Request) {
  return asDevice(request, "relay", RATE_LIMITS.deviceRelay, async (device, admin) => {
    const id = z.uuid().safeParse(new URL(request.url).searchParams.get("id"));
    if (!id.success) return json({ error: "invalid_input" }, 400);
    const approval = await supabaseStore(admin).getApproval(id.data);
    if (!approval || approval.device_id !== device.id) return json({ error: "not_found" }, 404);
    return json({ status: approvalStatus(approval) });
  });
}
