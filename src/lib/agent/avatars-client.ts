import { z } from "zod";

/**
 * Avatars (0220), one contract for the Settings page and the routes: GET /api/agent/avatars lists them, POST adds one,
 * PATCH {id, ...} changes one, DELETE ?id= removes one (owner session only). GET /api/voice/fish/model?id= checks a
 * Fish Audio voice id and answers its title; POST /api/voice/tts {text, voice} plays a preview in that voice. Which
 * avatar is active is agent_settings (PATCH /api/agent/state {activeAvatarId}).
 */

/** Fish Audio's model id: 32 lower-case hex (the TTS reference_id). A pasted id is trimmed and lower-cased first. */
export const FISH_VOICE_ID = /^[0-9a-f]{32}$/;
/**
 * Fish statuses that mean the voice itself is bad (unknown, private to another account, or malformed), one rule for
 * the model lookup and TTS. 401/402/429 are the key or the account, so another voice fails too.
 */
export const FISH_BAD_VOICE: ReadonlySet<number> = new Set([400, 403, 404, 422]);
export const voiceIdSchema = z.string().trim().toLowerCase().regex(FISH_VOICE_ID, "Not a Fish voice ID (32 letters and digits)");

export const avatarFields = z
  .object({
    name: z.string().trim().min(1, "Type a name").max(40, "1 to 40 characters"),
    voiceId: voiceIdSchema,
    curse: z.boolean(),
    slang: z.boolean(),
    styleNotes: z.string().trim().max(1000, "Up to 1000 characters"),
  })
  .strict();
export const newAvatar = avatarFields.partial({ curse: true, slang: true, styleNotes: true });
export const avatarPatch = avatarFields
  .partial()
  .extend({ id: z.uuid() })
  .refine((b) => Object.keys(b).length > 1, { message: "nothing to change" });

export interface AvatarView {
  id: string;
  name: string;
  voiceId: string;
  curse: boolean;
  slang: boolean;
  styleNotes: string;
}
export type AvatarInput = z.input<typeof newAvatar>;
/** What Fish says about a voice: its title, a sample clip when it has one, its languages. */
export interface FishVoice {
  id: string;
  title: string;
  sampleUrl: string | null;
  languages: string[];
}

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };
const UNREACHABLE = "Could not reach Hydra. Try again.";

async function call<T>(url: string, init: RequestInit | undefined, fetchImpl: typeof fetch, pick: (body: Record<string, unknown>) => T): Promise<Result<T>> {
  try {
    const res = await fetchImpl(url, { ...init, headers: { "content-type": "application/json" }, cache: "no-store" });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && body) return { ok: true, data: pick(body) };
    if (res.status === 401 || res.status === 403) return { ok: false, message: "Sign in as the owner" };
    const message = body && typeof body.message === "string" ? body.message : null;
    return { ok: false, message: message ?? (res.status === 400 ? "Not saved: check the values" : UNREACHABLE) };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}

const URL_ = "/api/agent/avatars";

/** The client the Settings page uses (tests pass their own fetch). */
export function avatarsClient(fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  return {
    list: () => call(URL_, undefined, fetchImpl, (b) => (Array.isArray(b.avatars) ? (b.avatars as AvatarView[]) : [])),
    create: (input: AvatarInput) => call(URL_, { method: "POST", body: JSON.stringify(input) }, fetchImpl, (b) => b.avatar as AvatarView),
    update: (id: string, patch: Partial<AvatarInput>) => call(URL_, { method: "PATCH", body: JSON.stringify({ id, ...patch }) }, fetchImpl, (b) => b.avatar as AvatarView),
    /** `data`: the activity id that undoes it (the undo bar), when the server has one. */
    remove: (id: string) => call(`${URL_}?id=${encodeURIComponent(id)}`, { method: "DELETE" }, fetchImpl, (b) => (typeof b.activityId === "string" ? b.activityId : null)),
    /** Checks a pasted id with Fish (through the server: the key never reaches the page). */
    voice: async (raw: string): Promise<Result<FishVoice>> => {
      const id = voiceIdSchema.safeParse(raw);
      if (!id.success) return { ok: false, message: id.error.issues[0]!.message };
      return call(`/api/voice/fish/model?id=${id.data}`, undefined, fetchImpl, (b) => b as unknown as FishVoice);
    },
    /** A short line in that voice, as an mp3 (Fish's free model: no spend). */
    preview: async (voice: string, text: string): Promise<Result<Blob>> => {
      try {
        const res = await fetchImpl("/api/voice/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice }) });
        if (res.ok) return { ok: true, data: await res.blob() };
        if (res.status === 503) return { ok: false, message: "No Fish Audio key on the server" };
        return { ok: false, message: "Fish could not speak with this voice" };
      } catch {
        return { ok: false, message: UNREACHABLE };
      }
    },
  };
}
export type AvatarsClient = ReturnType<typeof avatarsClient>;
