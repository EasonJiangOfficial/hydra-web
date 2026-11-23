import type { SupabaseClient } from "@supabase/supabase-js";
import { FISH_BAD_VOICE, FISH_VOICE_ID } from "@/lib/agent/avatars-client";
import { asDevice } from "@/lib/agent/caller";
import { bearer, RATE_LIMITS } from "@/lib/agent/devices";
import { supabaseStore } from "@/lib/agent/store";
import { createServerClient } from "@/lib/supabase/server";

/**
 * Hydra's own voice with no avatar active: a Fish Audio voice model id (32 hex) from FISH_DEFAULT_VOICE_ID. Pick any voice on
 * fish.audio and paste its id. Unset: a placeholder id that Fish refuses, so set it before using the voice.
 */
export const FISH_REFERENCE_ID = /^[0-9a-f]{32}$/.test(process.env.FISH_DEFAULT_VOICE_ID ?? "") ? process.env.FISH_DEFAULT_VOICE_ID! : "00000000000000000000000000000000";
const FISH_URL = "https://api.fish.audio/v1/tts";
/**
 * Fish's free API model ($0.00 per million bytes, docs.fish.audio pricing page). Without a model header Fish used a
 * paid default, and the owner's free plan has no API balance, so every request got 402 (owner, 2026-11-22).
 */
const FISH_MODEL = "s2.1-pro-free";
/** One sentence or two per request; the client speaks a reply sentence by sentence. */
const MAX_CHARS = 1000;

const fail = (status: number, error: string) => Response.json({ error }, { status });

/**
 * POST {"text": "..."} -> audio/mpeg, streamed from Fish Audio. The owner's session, or Hydra Desktop
 * with its device key (scope "agent", rate limited), so the Mac speaks with the server's key (it
 * spends money: nobody else). The key lives in FISH_AUDIO_API_KEY on the server and never reaches
 * a client. Without it: 503 `voice_not_configured`, and the client falls back to its own voice.
 * The voice is the active avatar's (0220, agent_settings.active_avatar_id), else FISH_REFERENCE_ID; when Fish refuses
 * the avatar's voice, the sentence is said once more in FISH_REFERENCE_ID. `voice` (a Fish id) previews that voice
 * on the Settings page: the owner's session only (403 for a device), never retried in another voice.
 */
export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return fail(415, "send_json");

  const owner = await ownerDb();
  if (owner) return speak(request, owner, true);
  if (bearer(request)) return asDevice(request, "agent", RATE_LIMITS.deviceTts, (_device, admin) => speak(request, admin, false));
  return fail(403, "not_owner");
}

async function ownerDb(): Promise<SupabaseClient | null> {
  try {
    const supabase = await createServerClient();
    const { data, error } = await supabase.rpc("is_owner");
    return !error && data === true ? supabase : null;
  } catch {
    return null;
  }
}

/** The active avatar's voice, or Hydra's own (no avatar, or the settings cannot be read). */
async function activeVoice(db: SupabaseClient): Promise<string> {
  try {
    const id = (await supabaseStore(db).settings()).activeAvatar?.voiceId;
    return id && FISH_VOICE_ID.test(id) ? id : FISH_REFERENCE_ID;
  } catch (error) {
    console.error(`[voice] avatar voice: ${(error as Error).message}`);
    return FISH_REFERENCE_ID;
  }
}

async function speak(request: Request, db: SupabaseClient, owner: boolean): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const text = body && typeof body === "object" && "text" in body ? (body as { text: unknown }).text : null;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_CHARS) return fail(400, "invalid_text");
  const asked = body && typeof body === "object" && "voice" in body ? (body as { voice: unknown }).voice : undefined;
  if (asked !== undefined) {
    if (!owner) return fail(403, "owner_only");
    if (typeof asked !== "string" || !FISH_VOICE_ID.test(asked)) return fail(400, "invalid_voice");
  }

  const key = process.env.FISH_AUDIO_API_KEY;
  if (!key) return fail(503, "voice_not_configured");

  const voice = asked ?? (await activeVoice(db));
  let upstream = await say(key, text.trim(), voice, request.signal);
  if (upstream && !upstream.ok && asked === undefined && voice !== FISH_REFERENCE_ID && FISH_BAD_VOICE.has(upstream.status)) {
    console.error(`[voice] the avatar's voice failed (${upstream.status}); Hydra's own voice says it`);
    upstream = await say(key, text.trim(), FISH_REFERENCE_ID, request.signal);
  }
  if (!upstream) return fail(502, "voice_upstream");
  if (!upstream.ok || !upstream.body) {
    console.error(`[voice] Fish Audio answered ${upstream.status}`);
    return fail(502, "voice_upstream");
  }
  return new Response(upstream.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}

/** One Fish TTS request; null when Fish cannot be reached. */
async function say(key: string, text: string, voice: string, signal: AbortSignal): Promise<Response | null> {
  try {
    return await fetch(FISH_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", model: FISH_MODEL },
      body: JSON.stringify({ text, reference_id: voice, format: "mp3", latency: "balanced", normalize: true }),
      signal,
    });
  } catch {
    return null;
  }
}
