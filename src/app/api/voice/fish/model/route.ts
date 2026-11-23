import { ownerSession } from "@/lib/agent/caller";
import { FISH_BAD_VOICE, voiceIdSchema, type FishVoice } from "@/lib/agent/avatars-client";

const fail = (status: number, error: string, message: string) => Response.json({ error, message }, { status });

/**
 * GET /api/voice/fish/model?id=<32 hex> (owner session only): checks a Fish Audio voice id with Fish's
 * GET /model/{id}, using FISH_AUDIO_API_KEY on the server (it never reaches the page), and answers
 * {id, title, sampleUrl, languages}. 400 for a malformed id; 404 unknown_voice when Fish does not know it (or it is
 * not a voice that can speak yet); 503 without the key; 502 when Fish cannot be reached.
 */
export async function GET(request: Request) {
  let owner = false;
  try {
    owner = (await ownerSession()) !== null;
  } catch {
    owner = false;
  }
  if (!owner) return fail(403, "not_owner", "Sign in as the owner");
  const id = voiceIdSchema.safeParse(new URL(request.url).searchParams.get("id") ?? "");
  if (!id.success) return fail(400, "invalid_input", id.error.issues[0]!.message);
  const key = process.env.FISH_AUDIO_API_KEY;
  if (!key) return fail(503, "voice_not_configured", "No Fish Audio key on the server");

  let res: Response;
  try {
    res = await fetch(`https://api.fish.audio/model/${id.data}`, { headers: { authorization: `Bearer ${key}` }, signal: request.signal, cache: "no-store" });
  } catch {
    return fail(502, "voice_upstream", "Could not reach Fish Audio. Try again.");
  }
  if (FISH_BAD_VOICE.has(res.status)) return fail(404, "unknown_voice", "Fish has no voice with this ID");
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) {
    console.error(`[voice] Fish model lookup answered ${res.status}`);
    return fail(502, "voice_upstream", "Could not reach Fish Audio. Try again.");
  }
  // A model still training, or one that failed, cannot speak yet.
  if (typeof body.state === "string" && body.state !== "trained") return fail(404, "unknown_voice", "This Fish voice is not ready yet");
  const samples = Array.isArray(body.samples) ? (body.samples as Record<string, unknown>[]) : [];
  const audio = samples.map((s) => s?.audio).find((a): a is string => typeof a === "string" && a.startsWith("https://"));
  const voice: FishVoice = {
    id: id.data,
    title: typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 100) : "Untitled voice",
    sampleUrl: audio ?? null,
    languages: Array.isArray(body.languages) ? body.languages.filter((l): l is string => typeof l === "string").slice(0, 10) : [],
  };
  return Response.json(voice, { headers: { "cache-control": "private, max-age=300" } });
}
