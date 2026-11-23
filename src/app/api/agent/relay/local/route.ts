import { z } from "zod";
import { asDevice, json, readJson } from "@/lib/agent/caller";
import { RATE_LIMITS } from "@/lib/agent/devices";
import { appendLocalTurn, localTurnSchema } from "@/lib/agent/relay";
import { supabaseStore } from "@/lib/agent/store";

/**
 * POST /api/agent/relay/local {user, assistant, threadId?, at?} (Hydra Desktop, scope "relay"): a turn
 * the owner had with Hydra on the Mac itself joins the shared thread, so the web, the phone and the
 * next relay turn's history see it. With threadId: that thread (404 when it is not his). Without: his
 * newest thread updated in the last 30 minutes, else a new one. Answers 200 {threadId}; the Mac keeps
 * it as its current thread for 30 minutes of quiet.
 */
export async function POST(request: Request) {
  return asDevice(request, "relay", RATE_LIMITS.deviceRelay, async (_device, admin) => {
    const body = localTurnSchema.safeParse(await readJson(request));
    if (!body.success) return json({ error: "invalid_input", message: z.prettifyError(body.error) }, 400);
    const threadId = await appendLocalTurn(supabaseStore(admin), body.data);
    if (!threadId) return json({ error: "not_found" }, 404);
    return json({ threadId });
  });
}
