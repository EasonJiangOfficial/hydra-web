"use server";

import { z } from "zod";

import type { NoteFull, NoteListItem, SaveOutcome } from "@/components/notes/types";
import { activityIdOf } from "@/lib/activity/request";
import { ownerSession } from "@/lib/agent/caller";
import { docSchema, TITLE_MAX } from "@/lib/notes/doc";
import { createNote, deleteNote, getNote, listNotes, summary, updateNote, type NoteRow } from "@/lib/notes/queries";

/**
 * The Notes page's server actions, on the owner's session (RLS applies; Activity logs every change, so
 * a delete has the 30-day undo). A server action takes anything from the browser: every input is parsed.
 */

const id = z.uuid();
const patchSchema = z.object({ title: z.string().max(TITLE_MAX).optional(), doc: docSchema.optional() }).strict();

const item = (n: NoteRow): NoteListItem => summary(n);
const full = (n: NoteRow): NoteFull => ({ ...item(n), doc: n.doc });

async function owner() {
  const db = await ownerSession();
  if (!db) throw new Error("Sign in as the owner");
  return db;
}

/** One note with its document, or null when it is gone. */
export async function loadNote(noteId: string): Promise<NoteFull | null> {
  const n = await getNote(await owner(), id.parse(noteId));
  return n && full(n);
}

/** The ids of the notes whose title or text match the words (prefix). */
export async function searchNotes(query: string): Promise<string[]> {
  const q = z.string().max(200).parse(query);
  return (await listNotes(await owner(), { query: q })).map((n) => n.id);
}

/** A new empty note from the page. */
export async function addNote(): Promise<NoteFull> {
  const { note } = await createNote(await owner(), { doc: [], source: "web" });
  return full(note);
}

/** Saves the title and/or document if the note is still at `expected` (its updated_at when loaded or last saved). */
export async function saveNote(noteId: string, patch: unknown, expected: string): Promise<SaveOutcome> {
  const p = patchSchema.safeParse(patch);
  if (!id.safeParse(noteId).success || !p.success || typeof expected !== "string" || (p.data.title === undefined && p.data.doc === undefined)) {
    return { ok: false, reason: "failed" };
  }
  try {
    const r = await updateNote(await owner(), noteId, p.data, expected);
    if (r.ok) return { ok: true, note: item(r.note) };
    return r.reason === "conflict" ? { ok: false, reason: "conflict", note: full(r.note) } : { ok: false, reason: r.reason };
  } catch (error) {
    console.error(`[notes] save: ${(error as Error).message}`);
    return { ok: false, reason: "failed" };
  }
}

export async function pinNote(noteId: string, pinned: boolean): Promise<boolean> {
  const r = await updateNote(await owner(), id.parse(noteId), { pinned: z.boolean().parse(pinned) });
  return r.ok;
}

/** Deletes a note (the page asked first). Returns the activity that undoes it. */
export async function removeNote(noteId: string): Promise<{ ok: boolean; activityId: string | null }> {
  const db = await owner();
  const before = await deleteNote(db, id.parse(noteId));
  return { ok: !!before, activityId: before ? activityIdOf(db) : null };
}
