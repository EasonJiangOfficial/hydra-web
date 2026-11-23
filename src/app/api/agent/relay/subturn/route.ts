import { z } from "zod";
import { asDevice, json, readJson } from "@/lib/agent/caller";
import { RATE_LIMITS } from "@/lib/agent/devices";
import { MAC_OFFLINE, RELAY_ONLINE_MS, relaySubturnSchema, subturnResult, supabaseRelay } from "@/lib/agent/relay";

/**
 * The phone controls the Mac (owner, 2026-11-22: "also using it from my phone it should be able to
 * control stuff from my computer"; W5 contract section 7). Hydra's server brain, device key with scope
 * "relay" and role brain.
 *
 * POST {turnId, claimId, instruction}: inside the web or phone turn the brain holds under claimId, a
 * sub-turn for the Mac (its thread, surface and context, Mac tools only). Only a Mac claims it; its
 * asks become relay approvals that show on every surface with the Mac's own words; nothing of it
 * streams to the browser or goes into the thread (the brain says the outcome). No Mac online: it is
 * closed at once ("Your Mac is offline."). 201 {subTurnId}; 400 invalid_input / not_live (a sub-turn
 * or a routine), 403 not_yours / not_brain, 404 not_found, 409 stale_claim.
 *
 * GET ?id=: {status: queued | claimed | done | error | expired, text} of a sub-turn of a turn this
 * brain holds (else 404). The brain polls until done, error or expired; text is the tool result. A
 * queued one whose Mac went offline ends now: expired, "Your Mac is offline.". One the parent's end
 * expired says so. All of the Mac's events count (read page by page).
 */
const PARENT_ENDED = "The turn ended before your Mac finished.";

async function allEvents(relay: ReturnType<typeof supabaseRelay>, turnId: string) {
  const all: Awaited<ReturnType<typeof relay.eventsAfter>> = [];
  for (let page = await relay.eventsAfter(turnId, 0); page.length > 0; page = await relay.eventsAfter(turnId, page.at(-1)!.seq)) all.push(...page);
  return all;
}

const REFUSED = { not_found: 404, stale_claim: 409, not_yours: 403, not_brain: 403, not_live: 400 } as const;

export async function POST(request: Request) {
  return asDevice(request, "relay", RATE_LIMITS.deviceRelay, async (device, admin) => {
    const body = relaySubturnSchema.safeParse(await readJson(request));
    if (!body.success) return json({ error: "invalid_input", message: z.prettifyError(body.error) }, 400);
    const { turnId, claimId, instruction } = body.data;
    const { id, outcome } = await supabaseRelay(admin).createSubturn(turnId, device.id, claimId, instruction);
    if (!id || outcome in REFUSED) return json({ error: outcome }, REFUSED[outcome as keyof typeof REFUSED] ?? 404);
    return json({ subTurnId: id }, 201);
  });
}

export async function GET(request: Request) {
  return asDevice(request, "relay", RATE_LIMITS.deviceRelay, async (device, admin) => {
    const id = z.uuid().safeParse(new URL(request.url).searchParams.get("id"));
    if (!id.success) return json({ error: "invalid_input" }, 400);
    const relay = supabaseRelay(admin);
    const sub = await relay.getTurn(id.data);
    const parent = sub?.parent_turn_id ? await relay.getTurn(sub.parent_turn_id) : null;
    if (!sub || !parent || parent.claimed_by !== device.id) return json({ error: "not_found" }, 404);
    if (sub.status === "queued" && !(await relay.macOnline(new Date(Date.now() - RELAY_ONLINE_MS), "mac")) && (await relay.expire(sub.id, ["queued"]))) {
      return json(subturnResult("expired", await allEvents(relay, sub.id), MAC_OFFLINE.message));
    }
    return json(subturnResult(sub.status, await allEvents(relay, sub.id), parent.status === "claimed" ? undefined : PARENT_ENDED));
  });
}
