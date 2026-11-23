import type { SupabaseClient } from "@supabase/supabase-js";
import { FISH_BAD_VOICE, FISH_VOICE_ID } from "@/lib/agent/avatars-client";
import { asDevice } from "@/lib/agent/caller";
import { bearer, RATE_LIMITS } from "@/lib/agent/devices";
import { supabaseStore } from "@/lib/agent/store";
import { createServerClient } from "@/lib/supabase/server";

const PLACEHOLDER_VOICE_ID = "00000000000000000000000000000000";

/**
 * Hydra's own voice with no avatar active. Set FISH_DEFAULT_VOICE_ID to a Fish Audio voice id
 * (32 hex characters). Unset or invalid: a placeholder id that Fish refuses.
 */
export function fishReferenceId(): string {
  const id = process.env.FISH_DEFAULT_VOICE_ID?.trim() ?? "";
  return /^[0-9a-f]{32}$/.test(id) ? id : PLACEHOLDER_VOICE_ID;
}
const FISH_URL = "https://api.fish.audio/v1/tts";
/**
 * Fish's free API model ($0.00 per million bytes, docs.fish.audio pricing page). Without a model header Fish used a
 * paid default, and the owner's free plan has no API balance, so every request got 402 (owner, 2026-11-22).
 */
const FISH_MODEL = "s2.1-pro-free";
/** One sentence or two per request; the client speaks a reply sentence by sentence. */
const MAX_CHARS = 1000;
/** Fish must send response headers within this, or the attempt is dropped; Hydra Desktop gives up at 20 s. */
const FISH_DEADLINE_MS = 6_000;
/**
 * All Fish attempts for one sentence end this long after the request arrived: every attempt gets at most the time
 * left, never a fresh FISH_DEADLINE_MS. Hydra Desktop gives up at 20 s, so 7 s stay for cold start, auth, the network
 * and the mp3 body.
 */
const SENTENCE_BUDGET_MS = 13_000;
/** An attempt with less time left than this is not sent: Fish could not answer it in time. */
const MIN_ATTEMPT_MS = 1_000;
/** Never more than this many Fish requests for one sentence (avatar fallback + one busy retry). */
const MAX_ATTEMPTS = 3;
/** Fish is busy or slow (5xx, 429, our deadline): worth one more try. */
const busy = (status: number | "deadline") => status === "deadline" || status === 429 || status >= 500;

const fail = (status: number, error: string) => Response.json({ error }, { status });

/**
 * POST {"text": "..."} -> audio/mpeg, streamed from Fish Audio. The owner's session, or Hydra Desktop
 * with its device key (scope "agent", rate limited), so the Mac speaks with the server's key (it
 * spends money: nobody else). The key lives in FISH_AUDIO_API_KEY on the server and never reaches
 * a client. Without it: 503 `voice_not_configured`, and the client falls back to its own voice.
 * The voice is the active avatar's (0220, agent_settings.active_avatar_id), else fishReferenceId(); when Fish refuses
 * the avatar's voice, the sentence is said once more in fishReferenceId(). `voice` (a Fish id) previews that voice
 * on the Settings page: the owner's session only (403 for a device), never retried in another voice.
 */
export async function POST(request: Request) {
  const end = Date.now() + SENTENCE_BUDGET_MS;
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return fail(415, "send_json");

  const owner = await ownerDb();
  if (owner) return speak(request, owner, true, end);
  if (bearer(request)) return asDevice(request, "agent", RATE_LIMITS.deviceTts, (_device, admin) => speak(request, admin, false, end));
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
    return id && FISH_VOICE_ID.test(id) ? id : fishReferenceId();
  } catch (error) {
    console.error(`[voice] avatar voice: ${(error as Error).message}`);
    return fishReferenceId();
  }
}

async function speak(request: Request, db: SupabaseClient, owner: boolean, end: number): Promise<Response> {
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

  return attempts(key, text.trim(), asked ?? (await activeVoice(db)), asked === undefined, request.signal, end);
}

/**
 * Says one sentence, at most MAX_ATTEMPTS Fish requests: a bad avatar voice (FISH_BAD_VOICE) is said once more in
 * fishReferenceId(); a busy free model (5xx, 429, deadline) gets one quick retry. Only the free model FISH_MODEL is
 * ever used (owner, 2026-11-22: "No, stay free"). Key or account faults (401, 402, 403 on Hydra's voice) are never retried.
 * All of it ends by `end` (SENTENCE_BUDGET_MS). A client abort stops at once.
 */
async function attempts(key: string, text: string, first: string, canSwitchVoice: boolean, signal: AbortSignal, end: number): Promise<Response> {
  let voice = first;
  let retried = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const left = end - Date.now();
    if (left < MIN_ATTEMPT_MS) {
      console.error(`[voice] Fish Audio not asked: sentence budget spent (model ${FISH_MODEL}, attempt ${attempt})`);
      break;
    }
    const upstream = await say(key, text, voice, signal, Math.min(FISH_DEADLINE_MS, left));
    if (upstream === "aborted" || signal.aborted) return fail(499, "client_closed");
    if (upstream instanceof Response && upstream.ok && upstream.body) {
      return new Response(upstream.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
    }
    if (upstream instanceof Response) void upstream.body?.cancel().catch(() => {});
    const status = upstream instanceof Response ? upstream.status : upstream;
    const hint = status === 402 ? "; 402 on the free model: check the model header" : "";
    console.error(`[voice] Fish Audio answered ${status} (model ${FISH_MODEL}, attempt ${attempt})${hint}`);

    if (canSwitchVoice && voice !== fishReferenceId() && typeof status === "number" && FISH_BAD_VOICE.has(status)) {
      voice = fishReferenceId(); // the avatar's voice is bad: Hydra's own voice says it
      continue;
    }
    if (status === "network" || !busy(status) || retried) break;
    retried = true;
    if (!(await pause(status === 429 ? 600 : 250, signal))) return fail(499, "client_closed");
  }
  return fail(502, "voice_upstream");
}

/** Waits ms; false when the client went away meanwhile. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const done = () => {
      clearTimeout(timer);
      resolve(!signal.aborted);
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** One Fish TTS request with a header deadline of `deadlineMs`; "network" when Fish cannot be reached. */
async function say(key: string, text: string, voice: string, signal: AbortSignal, deadlineMs: number): Promise<Response | "deadline" | "network" | "aborted"> {
  if (signal.aborted) return "aborted";
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal.addEventListener("abort", onAbort, { once: true }); // kept on success: a client abort also stops the body
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    ctl.abort();
  }, deadlineMs);
  try {
    return await fetch(FISH_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", model: FISH_MODEL },
      body: JSON.stringify({ text, reference_id: voice, format: "mp3", latency: "balanced", normalize: true }),
      signal: ctl.signal,
    });
  } catch {
    signal.removeEventListener("abort", onAbort);
    return signal.aborted ? "aborted" : late ? "deadline" : "network";
  } finally {
    clearTimeout(timer);
  }
}
