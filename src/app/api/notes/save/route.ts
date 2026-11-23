import { saveNote } from "@/app/(app)/notes/actions";
import { json, readJson } from "@/lib/agent/caller";

/**
 * The Notes page's save as a plain POST, for a tab that is hiding: the page sends it with fetch keepalive,
 * which a server action cannot use, so it lands even when the page goes. Owner session only (saveNote
 * checks it); JSON only, so a cross-site form cannot post here. Body {id, patch, expected}; answers the
 * SaveOutcome.
 */
export async function POST(request: Request) {
  const b = await readJson(request);
  if (!b || typeof b !== "object") return json({ ok: false, reason: "failed" }, 400);
  const { id, patch, expected } = b as Record<string, unknown>;
  return json(await saveNote(String(id), patch, typeof expected === "string" ? expected : ""));
}
