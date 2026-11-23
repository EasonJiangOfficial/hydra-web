"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { Label } from "@/components/kit";

/** A label with its control, as one drawer row: gray label on the left, control fills the rest. */
export function FieldRow({ label, htmlFor, children }: { label: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[46px] items-center gap-3 border-t border-rule py-2 first:border-t-0">
      <Label as="label" htmlFor={htmlFor} className="w-24 shrink-0">
        {label}
      </Label>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </div>
  );
}

export type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Autosave for one text field. `edit` shows the text at once and saves 600 ms after the last key
 * (or on blur, through `flush`). A server refusal keeps the typed text and says "Not saved".
 * `value` is the saved value: it replaces the draft only while nothing is being typed.
 */
export function useAutosave(value: string, save: (next: string) => Promise<boolean>, delay = 600) {
  const [draft, setDraft] = useState(value);
  const [state, setState] = useState<SaveState>("idle");
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(draft);
  const saver = useRef(save);
  useEffect(() => {
    saver.current = save;
  });

  // Follow the saved value when the owner is not typing (another device, an undo).
  useEffect(() => {
    if (!dirty.current) {
      setDraft(value);
      latest.current = value;
    }
  }, [value]);

  const flush = async (): Promise<void> => {
    window.clearTimeout(timer.current);
    if (!dirty.current) return;
    const text = latest.current;
    setState("saving");
    const ok = await saver.current(text);
    if (latest.current === text) dirty.current = false;
    setState(ok ? "saved" : "error");
  };

  const edit = (next: string): void => {
    dirty.current = true;
    latest.current = next;
    setDraft(next);
    setState("idle");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), delay);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { draft, state, edit, flush };
}

/** "Saving", "Saved" or "Not saved": 12 px gray text, announced politely, no layout shift. */
export function SaveLabel({ state }: { state: SaveState }) {
  const text = state === "saving" ? "Saving" : state === "saved" ? "Saved" : state === "error" ? "Not saved" : "";
  return (
    <span role="status" aria-live="polite" data-save-state={state} className="min-w-14 text-right text-tag text-ink-3">
      {text}
    </span>
  );
}
