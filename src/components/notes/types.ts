import type { NoteDoc, NoteSource } from "@/lib/notes/doc";

/** One row of the Notes list: no document. */
export type NoteListItem = {
  id: string;
  title: string;
  preview: string;
  source: NoteSource;
  pinned: boolean;
  created_at: string;
  updated_at: string;
};

/** An open note: the row and its block document. */
export type NoteFull = NoteListItem & { doc: NoteDoc };

export type NotePatch = { title?: string; doc?: NoteDoc };

/** Keys typed while New note was on its way: the title's, then, after an Enter, the text's (null: no Enter). */
export type TypedEarly = { title: string; body: string | null };

/**
 * A save: the row as saved, or why not (another tab or device changed it first, it was deleted, or it failed).
 * A conflict carries the note as the server has it.
 */
export type SaveOutcome = { ok: true; note: NoteListItem } | { ok: false; reason: "conflict"; note: NoteFull } | { ok: false; reason: "gone" | "failed" };

/** `keepalive`: the tab is hiding, so the save goes out in a way that outlives the page. */
export type SaveOptions = { keepalive?: boolean };

/** What the Notes page does. The live page passes server actions, /dev/notes passes memory ones. */
export interface NotesActions {
  /** The note; null when it is gone; "failed" when it could not be read (offline, the server down). */
  open(id: string): Promise<NoteFull | null | "failed">;
  /** The ids of the notes matching the words, or null when the search failed. */
  search(query: string): Promise<string[] | null>;
  create(): Promise<NoteFull | null>;
  /** Compare-and-set on `expected`, the updated_at this copy was loaded or last saved with. */
  save(id: string, patch: NotePatch, expected: string, options?: SaveOptions): Promise<SaveOutcome>;
  pin(id: string, pinned: boolean): Promise<boolean>;
  /** On success, the activity id that undoes it (null on fixtures). */
  remove(id: string): Promise<{ ok: boolean; activityId?: string | null }>;
}
