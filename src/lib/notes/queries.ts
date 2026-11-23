import type { SupabaseClient } from "@supabase/supabase-js";
import { docToText, preview, storable, textToDoc, type NoteDoc, type NoteSource } from "./doc";

/**
 * Notes reads and writes on a caller's client (the owner's session: RLS applies and Activity logs each
 * change). The Notes page, the agent's note tools and /api/agent/notes all call these.
 */

export type NoteRow = {
  id: string;
  title: string;
  doc: NoteDoc;
  text: string;
  source: NoteSource;
  device_id: string | null;
  thread_id: string | null;
  client_id: string | null;
  pinned: boolean;
  created_at: string;
  updated_at: string;
};

/** A list row: no document, the first line of the text. */
export type NoteSummary = Pick<NoteRow, "id" | "title" | "source" | "pinned" | "created_at" | "updated_at"> & { preview: string };

const ROW = "id, title, doc, text, source, device_id, thread_id, client_id, pinned, created_at, updated_at";
const LIST = "id, title, text, source, pinned, created_at, updated_at";
export const LIST_MAX = 200;

/** A database refusal, with its Postgres code (23503: a thread or device that does not exist). */
export class NotesError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(`notes: ${message}`);
  }
}
const fail = (e: { message: string; code?: string }) => new NotesError(e.message, e.code);

/** A note as a list row. */
export const summary = (n: Pick<NoteRow, "id" | "title" | "text" | "source" | "pinned" | "created_at" | "updated_at">): NoteSummary => ({
  id: n.id,
  title: n.title,
  preview: preview(n.text, 140, n.title),
  source: n.source,
  pinned: n.pinned,
  created_at: n.created_at,
  updated_at: n.updated_at,
});

/** A prefix query from free words: "oat mil" -> "oat:* & mil:*". Only letters and digits reach to_tsquery. */
export function searchQuery(q: string): string | null {
  const terms = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8);
  return terms.length ? terms.map((t) => `${t}:*`).join(" & ") : null;
}

/** Notes, pinned first, then newest change first. `query` matches the title and the text by word prefix. */
export async function listNotes(db: SupabaseClient, opts: { query?: string; limit?: number } = {}): Promise<NoteSummary[]> {
  let q = db.from("notes").select(LIST);
  const tsq = opts.query ? searchQuery(opts.query) : null;
  if (tsq) q = q.textSearch("search", tsq, { config: "simple" });
  const { data, error } = await q
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? LIST_MAX, 1), LIST_MAX));
  if (error) throw fail(error);
  return ((data ?? []) as Parameters<typeof summary>[0][]).map(summary);
}

export async function getNote(db: SupabaseClient, id: string): Promise<NoteRow | null> {
  const { data, error } = await db.from("notes").select(ROW).eq("id", id).maybeSingle();
  if (error) throw fail(error);
  return (data as NoteRow | null) ?? null;
}

export type NewNote = {
  title?: string;
  /** The block document; or plain text, turned into blocks. */
  doc?: NoteDoc;
  text?: string;
  source: NoteSource;
  clientId?: string | null;
  threadId?: string | null;
  deviceId?: string | null;
};

/**
 * Adds a note. With a client_id this device already used (its retry), the first note comes back and nothing
 * is added. A client_id another device (or the owner's session) used is refused (NotesError "client_id_taken"):
 * client_id is unique across devices, and one device never gets another's note back.
 */
export async function createNote(db: SupabaseClient, input: NewNote): Promise<{ note: NoteRow; created: boolean }> {
  const doc = storable(input.doc ?? textToDoc(input.text ?? ""));
  const row = {
    title: storable(input.title ?? "").trim(),
    doc,
    text: docToText(doc),
    source: input.source,
    client_id: input.clientId ?? null,
    thread_id: input.threadId ?? null,
    device_id: input.deviceId ?? null,
  };
  const { data, error } = await db.from("notes").insert(row).select(ROW).single();
  if (!error) return { note: data as NoteRow, created: true };
  if (error.code === "23505" && input.clientId) {
    const { data: first, error: again } = await db.from("notes").select(ROW).eq("client_id", input.clientId).maybeSingle();
    if (again) throw fail(again);
    if (first && (first as NoteRow).device_id === (input.deviceId ?? null)) return { note: first as NoteRow, created: false };
    if (first) throw new NotesError("client_id is used by another device", "client_id_taken");
  }
  throw fail(error);
}

export type NotePatch = { title?: string; doc?: NoteDoc; pinned?: boolean };
export type SaveResult = { ok: true; note: NoteRow } | { ok: false; reason: "conflict"; note: NoteRow } | { ok: false; reason: "gone" };

/**
 * Changes a note. With `expected` (the updated_at the caller loaded), a compare-and-set: when the note
 * changed since, nothing is written and the current note comes back as a conflict.
 */
export async function updateNote(db: SupabaseClient, id: string, patch: NotePatch, expected?: string | null): Promise<SaveResult> {
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) row.title = storable(patch.title).trim();
  if (patch.doc !== undefined) {
    row.doc = storable(patch.doc);
    row.text = docToText(row.doc);
  }
  if (patch.pinned !== undefined) row.pinned = patch.pinned;
  let q = db.from("notes").update(row).eq("id", id);
  if (expected) q = q.eq("updated_at", expected);
  const { data, error } = await q.select(ROW).maybeSingle();
  if (error) throw fail(error);
  if (data) return { ok: true, note: data as NoteRow };
  const now = await getNote(db, id);
  return now ? { ok: false, reason: "conflict", note: now } : { ok: false, reason: "gone" };
}

/** Deletes a note; returns it as it was, or null when it is gone. */
export async function deleteNote(db: SupabaseClient, id: string): Promise<NoteRow | null> {
  const { data, error } = await db.from("notes").delete().eq("id", id).select(ROW).maybeSingle();
  if (error) throw fail(error);
  return (data as NoteRow | null) ?? null;
}
