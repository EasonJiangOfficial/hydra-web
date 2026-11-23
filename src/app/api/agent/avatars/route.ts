import { z } from "zod";
import { activityIdOf } from "@/lib/activity/request";
import { asOwner, json, readJson } from "@/lib/agent/caller";
import { avatarPatch, newAvatar } from "@/lib/agent/avatars-client";
import { supabaseStore } from "@/lib/agent/store";

/**
 * The owner's avatars (0220), owner session only (a paired device reads the active one in /api/agent/state).
 * GET {avatars} oldest first; POST {name, voiceId, curse?, slang?, styleNotes?} -> 201 {avatar}; PATCH {id, ...any of
 * them} -> {avatar}; DELETE ?id= -> {ok, activityId} (the undo bar's id; the active one going away puts Hydra's own voice back). 400 on anything
 * invalid, 404 for an unknown id. Each change is logged for undo (0130).
 */
const bad = (error: z.ZodError) => json({ error: "invalid_input", message: error.issues[0]?.message ?? "Not valid" }, 400);

export async function GET(request: Request) {
  return asOwner(request, null, async (caller) => json({ avatars: await supabaseStore(caller.db).listAvatars() }));
}

export async function POST(request: Request) {
  return asOwner(request, null, async (caller) => {
    const body = newAvatar.safeParse(await readJson(request));
    if (!body.success) return bad(body.error);
    const avatar = await supabaseStore(caller.db).createAvatar({ curse: false, slang: false, styleNotes: "", ...body.data });
    return json({ avatar }, 201);
  });
}

export async function PATCH(request: Request) {
  return asOwner(request, null, async (caller) => {
    const body = avatarPatch.safeParse(await readJson(request));
    if (!body.success) return bad(body.error);
    const { id, ...patch } = body.data;
    const avatar = await supabaseStore(caller.db).updateAvatar(id, patch);
    return avatar ? json({ avatar }) : json({ error: "not_found", message: "This avatar is gone" }, 404);
  });
}

export async function DELETE(request: Request) {
  return asOwner(request, null, async (caller) => {
    const id = z.uuid().safeParse(new URL(request.url).searchParams.get("id"));
    if (!id.success) return bad(id.error);
    const gone = await supabaseStore(caller.db).deleteAvatar(id.data);
    return gone ? json({ ok: true, activityId: activityIdOf(caller.db) }) : json({ error: "not_found", message: "This avatar is gone" }, 404);
  });
}
