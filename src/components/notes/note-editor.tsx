"use client";

import { ChevronLeft, Pin, PinOff, Trash2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/kit";
import { Skeleton } from "@/components/kit/skeleton";
import { TITLE_MAX, type NoteDoc } from "@/lib/notes/doc";

import type { NotesEditor } from "./block-editor";
import type { NoteSaver, SaveState } from "./saver";
import type { NoteFull, TypedEarly } from "./types";

/** BlockNote reads the DOM as it starts: browser only. */
const BlockEditor = dynamic(() => import("./block-editor"), {
  ssr: false,
  loading: () => (
    <div aria-hidden className="flex flex-col gap-3 px-12 pt-1 max-md:px-0">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  ),
});

const STATE_TEXT: Record<SaveState, string> = {
  idle: "",
  saving: "Saving",
  saved: "Saved",
  error: "Not saved yet, retrying",
  conflict: "",
  gone: "",
};

/** A key typed before the box it is for was there, applied to the text kept for it; null when it is not a text key. */
export function keyInto(text: string, e: Pick<KeyboardEvent, "key" | "isComposing" | "metaKey" | "ctrlKey" | "altKey">): string | null {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key.length === 1) return text + e.key;
  if (e.key === "Backspace") return text.slice(0, -1);
  if (e.key === "Enter") return `${text}\n`;
  return null;
}

/** Opens BlockNote's slash menu at the caret, as a typed "/" does. */
type SlashMenu = { openSuggestionMenu: (trigger: string, options?: { deleteTriggerCharacter?: boolean }) => void };
const openSlash = (e: NotesEditor) => (e.getExtension("suggestionMenu") as unknown as SlashMenu | undefined)?.openSuggestionMenu("/", { deleteTriggerCharacter: true });

/** Text typed before the editor was there that ends in a "/" starting a word: the text before it, and what follows the "/". */
function slashAtEnd(text: string): { before: string; query: string } | null {
  const m = /(^|\s)\/(\S*)$/.exec(text);
  return m ? { before: text.slice(0, m.index + m[1].length), query: m[2] } : null;
}

/**
 * One open note: the title, the block editor, and its autosave (the NoteSaver the Notes page keeps for
 * this note, so an edit still saving outlives the editor). The save state is quiet and shows on hover; a
 * save that keeps failing also leaves a small dot (and says so on the phone, which has no hover). A note changed elsewhere stops saving and asks: Keep
 * mine (save the local copy over it) or Reload (take the saved one). Nothing is merged.
 */
export function NoteEditor({
  note,
  saver,
  autoFocus,
  takeTyped,
  onTitle,
  onReload,
  onBack,
  onPin,
  onDelete,
}: {
  note: NoteFull;
  saver: NoteSaver;
  autoFocus?: boolean;
  /** The keys typed between New note and this title showing up: the title's, and after an Enter, the text's (null once taken). */
  takeTyped?: () => TypedEarly | null;
  /** The list row follows the title as it is typed. */
  onTitle: (title: string) => void;
  onReload: () => void;
  onBack: () => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [state, setState] = useState<SaveState>(() => saver.state);
  const editor = useRef<NotesEditor | null>(null);
  const titleBox = useRef<HTMLInputElement | null>(null);
  /** Enter came before the editor had loaded: the keys typed since, for the text once it has (null: no such Enter). */
  const early = useRef<string | null>(null);
  /** Keys typed while the note was being made went into the title: the caret goes after them. */
  const caretToEnd = useRef(false);

  const typeTitle = useCallback(
    (value: string) => {
      setTitle(value);
      onTitle(value);
      saver.edit({ title: value });
    },
    [onTitle, saver],
  );

  /** The text typed after an early Enter goes in at the top, and the caret after it. A "/" at its end opens the slash menu. */
  const startText = useCallback((e: NotesEditor) => {
    const typed = early.current ?? "";
    early.current = null;
    const slash = slashAtEnd(typed);
    const text = slash ? slash.before : typed;
    const first = e.document[0];
    const lines = text ? text.split("\n").map((l) => ({ type: "paragraph" as const, content: l })) : [];
    if (lines.length && first) {
      const blank = first.type === "paragraph" && Array.isArray(first.content) && first.content.length === 0;
      if (blank) e.replaceBlocks([first], lines);
      else e.insertBlocks(lines, first, "before");
    }
    const caret = () => {
      if (lines.length) e.setTextCursorPosition(e.document[lines.length - 1], "end");
      e.focus();
    };
    caret();
    if (slash) {
      openSlash(e);
      if (slash.query) e.insertInlineContent(slash.query);
    }
    // The editor can mount its view again in the same frame (React's strict mode), which drops the focus.
    requestAnimationFrame(() => !e.isFocused() && caret());
  }, []);

  // The owner just pressed New note: the title takes the keys, the ones typed while it was being made first;
  // an Enter among them moves on to the text, with the keys after it.
  useEffect(() => {
    if (!autoFocus) return;
    const box = titleBox.current;
    const typed = takeTyped ? takeTyped() : { title: "", body: null };
    if (!typed) return; // taken already (React's strict mode runs this twice)
    if (typed.title) {
      caretToEnd.current = true;
      typeTitle(`${box?.value ?? ""}${typed.title}`.slice(0, TITLE_MAX));
    }
    early.current = typed.body;
    if (typed.body !== null && editor.current) startText(editor.current);
    else box?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the new note opens
  }, []);
  useEffect(() => {
    const box = titleBox.current;
    if (!caretToEnd.current || !box) return;
    caretToEnd.current = false;
    box.setSelectionRange(box.value.length, box.value.length);
  }, [title]);

  // The saver keeps the state for the next visit; leaving the note saves now (it keeps retrying after).
  useEffect(() => {
    const unwatch = saver.watch(setState);
    return () => {
      unwatch();
      void saver.flush();
    };
  }, [saver]);

  const onChange = useCallback((doc: NoteDoc) => saver.edit({ doc }), [saver]);
  const onReady = useCallback(
    (e: NotesEditor) => {
      editor.current = e;
      if (early.current !== null) startText(e);
    },
    [startText],
  );
  const stopped = state === "conflict" || state === "gone";
  const keepMine = () => void saver.keepMine({ title, doc: (editor.current?.document as unknown as NoteDoc | undefined) ?? saver.unsent.doc ?? note.doc });

  return (
    <article aria-label={title.trim() || "Untitled"} className="flex min-h-full flex-col" data-note-id={note.id}>
      <div className="group/bar sticky top-0 z-10 flex h-12 flex-none items-center gap-1 bg-surface md:px-6">
        <Button variant="ghost" className="-ml-2 gap-1 px-2 md:hidden" onClick={onBack}>
          <ChevronLeft aria-hidden strokeWidth={1.5} />
          Notes
        </Button>
        <div className="flex-1" />
        <span role="status" aria-live="polite" data-save-state={state} className="flex items-center gap-1.5 text-tag text-ink-3">
          {/* The phone has no hover: a save that keeps failing says so there. */}
          <span className={`opacity-0 transition-opacity duration-200 group-hover/bar:opacity-100 ${state === "error" ? "max-md:opacity-100" : ""}`}>{STATE_TEXT[state]}</span>
          {state === "error" && <span aria-hidden className="size-1.5 rounded-full bg-ink-3" />}
        </span>
        <Button variant="ghost" size="icon-sm" className="size-8 max-md:size-9" aria-label={note.pinned ? "Unpin" : "Pin to top"} aria-pressed={note.pinned} onClick={onPin}>
          {note.pinned ? <PinOff aria-hidden strokeWidth={1.5} /> : <Pin aria-hidden strokeWidth={1.5} />}
        </Button>
        <Button variant="ghost" size="icon-sm" className="size-8 max-md:size-9" aria-label="Delete note" onClick={onDelete}>
          <Trash2 aria-hidden strokeWidth={1.5} />
        </Button>
      </div>
      {stopped && (
        <div role="alert" className="mb-2 flex min-h-10 items-center gap-1 rounded-lg bg-tint py-1 pr-1 pl-3.5 text-label text-ink-2 md:mx-6">
          <span className="flex-1">{state === "conflict" ? "Changed elsewhere" : "This note was deleted"}</span>
          {state === "conflict" && (
            <>
              <Button variant="ghost" className="h-8 px-2 text-label" onClick={keepMine}>
                Keep mine
              </Button>
              <Button variant="ghost" className="h-8 px-2 text-label" onClick={onReload}>
                Reload
              </Button>
            </>
          )}
        </div>
      )}
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-2 pt-6 pb-24 max-md:pt-2">
        <input
          ref={titleBox}
          aria-label="Title"
          value={title}
          maxLength={TITLE_MAX}
          placeholder="Untitled"
          onChange={(e) => typeTitle(e.target.value)}
          onKeyDown={(e) => {
            if (early.current !== null) {
              // Past an Enter, before the editor is there: the keys are the text's.
              const next = keyInto(early.current, e.nativeEvent);
              if (next === null) return;
              early.current = next;
              e.preventDefault();
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (editor.current) editor.current.focus();
              else early.current = "";
            }
          }}
          className="w-full bg-transparent px-12 text-figure text-ink outline-none placeholder:text-ink-3/60 max-md:px-0 max-md:text-title"
        />
        <BlockEditor initial={note.doc} onChange={onChange} onReady={onReady} />
      </div>
    </article>
  );
}
