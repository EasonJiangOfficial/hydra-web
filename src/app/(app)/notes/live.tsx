"use client";

import { useRouter } from "next/navigation";

import type { NoteFull, NoteListItem, NotePatch, NotesActions, SaveOutcome } from "@/components/notes/types";
import { NotesWorkspace } from "@/components/notes/workspace";

import { addNote, loadNote, pinNote, removeNote, saveNote, searchNotes } from "./actions";

/** A server action that cannot reach the server answers as a failure, never a throw into the page. */
const safe = async <T,>(call: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await call();
  } catch {
    return fallback;
  }
};

const FAILED = { ok: false, reason: "failed" } as const;

/** Fetch keepalive carries at most 64 KB; a larger note goes as a server action (the leave warning covers it). */
const KEEPALIVE_MAX = 60_000;

/** A save sent as the tab hides: fetch keepalive, so it lands even when the page goes. */
async function saveKeepalive(id: string, patch: NotePatch, expected: string): Promise<SaveOutcome> {
  const body = JSON.stringify({ id, patch, expected });
  // ponytail: a note over 64 KB falls back to the server action, which the page may not outlive; chunk it if that bites.
  if (new Blob([body]).size > KEEPALIVE_MAX) return safe(() => saveNote(id, patch, expected), FAILED);
  try {
    const r = await fetch("/api/notes/save", { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body });
    return r.ok ? ((await r.json()) as SaveOutcome) : FAILED;
  } catch {
    return FAILED;
  }
}

/**
 * The page's server actions, one set for the page load: the Notes page keeps its autosaves per set of
 * actions, so leaving Notes and coming back finds a save still on its way.
 */
const actions: NotesActions = {
  open: (id) => safe<NoteFull | null | "failed">(() => loadNote(id), "failed"),
  search: (q) => safe(() => searchNotes(q), null),
  create: () => safe(() => addNote(), null),
  save: (id, patch, expected, options) => (options?.keepalive ? saveKeepalive(id, patch, expected) : safe(() => saveNote(id, patch, expected), FAILED)),
  pin: (id, pinned) => safe(() => pinNote(id, pinned), false),
  remove: (id) => safe(() => removeNote(id), { ok: false, activityId: null }),
};

/** The Notes page on real data: the page's server actions (every change lands in Activity with undo). */
export function NotesLive({ notes, open }: { notes: NoteListItem[]; open: NoteFull | null }) {
  const router = useRouter();
  return <NotesWorkspace notes={notes} initialOpen={open} actions={actions} onRestored={() => router.refresh()} />;
}
