import "server-only";

import type { NoteFull, NoteListItem } from "@/components/notes/types";
import { ownerSession } from "@/lib/agent/caller";
import { getNote, listNotes, summary } from "@/lib/notes/queries";

/** The list and the note `?note=` names, read as the signed-in owner. Null when the caller is not the owner. */
export async function loadNotesData(noteId: string | null): Promise<{ notes: NoteListItem[]; open: NoteFull | null } | null> {
  const db = await ownerSession();
  if (!db) return null;
  const uuid = noteId && /^[0-9a-f-]{36}$/i.test(noteId) ? noteId : null;
  const [notes, n] = await Promise.all([listNotes(db), uuid ? getNote(db, uuid) : null]);
  const open = n && { ...summary(n), doc: n.doc };
  return { notes, open };
}
