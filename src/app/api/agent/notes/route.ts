import { z } from "zod";
import { asOwner, json, readJson } from "@/lib/agent/caller";
import { docSchema, SOURCES, TITLE_MAX } from "@/lib/notes/doc";
import { createNote, listNotes, NotesError } from "@/lib/notes/queries";

/**
 * Notes for Hydra Desktop and other paired devices. Owner session or a device key with the "agent" scope
 * (forwarded as the owner, so RLS applies and Activity logs the write).
 *
 * POST {title?, text | doc, source, client_id, thread_id?}: adds a note. Idempotent on client_id: a retry
 * answers 200 with the first note and adds nothing; a new note is 201. client_id is unique across devices
 * (make it globally unique, e.g. a uuid or a tool-use id): one another device used is 409.
 * GET ?q=words&limit=n: notes pinned first then newest, matching the words by prefix (no q: all).
 */

const postSchema = z
  .object({
    title: z.string().max(TITLE_MAX).optional(),
    text: z.string().max(20_000).optional(),
    doc: docSchema.optional(),
    source: z.enum(SOURCES),
    // Postgres text refuses U+0000 and a lone surrogate: a 400 here, not a 500 from the insert.
    client_id: z
      .string()
      .min(1)
      .max(200)
      .refine((s) => !s.includes("\0") && s.isWellFormed(), { message: "client_id has no U+0000 or lone surrogate" }),
    thread_id: z.uuid().nullish(),
  })
  .strict()
  .refine((b) => (b.text === undefined) !== (b.doc === undefined), { message: "send text or doc, not both" });

const out = (n: { id: string; title: string; text: string; source: string; pinned: boolean; client_id: string | null; created_at: string; updated_at: string }) => ({
  id: n.id,
  title: n.title,
  text: n.text,
  source: n.source,
  pinned: n.pinned,
  clientId: n.client_id,
  createdAt: n.created_at,
  updatedAt: n.updated_at,
});

export async function POST(request: Request) {
  return asOwner(request, "agent", async (caller) => {
    const body = postSchema.safeParse(await readJson(request));
    if (!body.success) return json({ error: "invalid_input", message: z.prettifyError(body.error) }, 400);
    const b = body.data;
    try {
      const { note, created } = await createNote(caller.db, {
        title: b.title,
        text: b.text,
        doc: b.doc,
        source: b.source,
        clientId: b.client_id,
        threadId: b.thread_id ?? null,
        deviceId: caller.deviceId,
      });
      return json({ note: out(note), created }, created ? 201 : 200);
    } catch (error) {
      if (error instanceof NotesError && error.code === "client_id_taken") return json({ error: "client_id_taken", message: "Another device used this client_id" }, 409);
      if (error instanceof NotesError && error.code === "23503") return json({ error: "invalid_input", message: "No such thread_id or device" }, 400);
      throw error;
    }
  });
}

export async function GET(request: Request) {
  return asOwner(request, "agent", async (caller) => {
    const params = new URL(request.url).searchParams;
    const q = params.get("q") ?? undefined;
    const limit = Number(params.get("limit") ?? 50);
    if ((q && q.length > 200) || !Number.isInteger(limit) || limit < 1 || limit > 200) return json({ error: "invalid_input" }, 400);
    return json({ notes: await listNotes(caller.db, { query: q, limit }) });
  });
}
