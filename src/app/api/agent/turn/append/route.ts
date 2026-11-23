import { z } from "zod";
import { asOwner, json, readJson } from "@/lib/agent/caller";
import { appendInputSchema } from "@/lib/agent/relay-schema";
import { supabaseStore } from "@/lib/agent/store";

/**
 * POST /api/agent/turn/append {turnId, text} (owner session, or a paired device through the bridge): words the owner
 * said or typed while a turn was thinking are added to it, never a new turn (W5 contract section 2; owner: "dont
 * cancel but add onto the prompt"). turnId is the `turn` event of the turn's stream. 202 {ok, seq}; 409 turn_over when
 * the turn already ended (the client then starts a new turn with the words); 400 invalid_input.
 */
export async function POST(request: Request) {
  return asOwner(request, "agent", async (caller) => {
    const body = appendInputSchema.safeParse(await readJson(request));
    if (!body.success) return json({ error: "invalid_input", message: z.prettifyError(body.error) }, 400);
    const seq = await supabaseStore(caller.db).appendInput(body.data.turnId, body.data.text);
    if (seq === null) return json({ error: "turn_over" }, 409);
    return json({ ok: true, seq }, 202);
  });
}
