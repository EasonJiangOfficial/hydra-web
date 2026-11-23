import { z } from "zod";
import { asOwner, json, ownerToolCtx, readJson } from "@/lib/agent/caller";
import { LIVE_GROUPS } from "@/lib/agent/config";
import { SURFACES } from "@/lib/agent/events";
import { supabaseStore } from "@/lib/agent/store";
import { undoAction } from "@/lib/agent/tools";

/**
 * POST /api/agent/undo {actionId}: one-tap undo from the activity list. The owner's tap in his own
 * session is his yes, so a gated inverse (undoing a create deletes the row) runs without a second
 * confirm. A paired device's undo is not: a gated inverse answers 409 and waits for the app.
 */
const bodySchema = z.object({ actionId: z.uuid(), surface: z.enum(SURFACES).default("web") });

export async function POST(request: Request) {
  return asOwner(request, "agent", async (caller) => {
    const body = bodySchema.safeParse(await readJson(request));
    if (!body.success) return json({ error: "invalid_input" }, 400);
    const store = supabaseStore(caller.db);
    const ctx = ownerToolCtx(caller, store, { surface: body.data.surface, allowed: LIVE_GROUPS });
    const res = await undoAction(body.data.actionId, ctx, { approved: caller.deviceId === null });
    if (res.status === "ok") return json({ ok: true, summary: res.summary, actionId: res.actionId });
    return json({ ok: false, message: res.status === "confirm" ? res.gate.summary : res.message }, 409);
  });
}
