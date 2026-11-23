"use client";

import { useId, useState, type ReactNode } from "react";
import type { ZodType } from "zod";

import { Input } from "@/components/kit";

const TITLE_ERROR = "Title can't be empty.";

/**
 * A drawer's top: the title is the editable field (its one home). Saves on blur or Enter; an
 * empty title shows an error and reverts. The drawer's own header (DetailDrawer) carries the
 * accessible name and the close button, so this sits just under it.
 */
export function DrawerHeader({
  title,
  schema,
  onSave,
  aside,
  label = "Title",
}: {
  title: string;
  schema: ZodType<string>;
  onSave: (title: string) => void;
  /** Right of the title: the save state. */
  aside?: ReactNode;
  label?: string;
}) {
  const [draft, setDraft] = useState(title);
  const [seen, setSeen] = useState(title);
  const [error, setError] = useState("");
  const errorId = useId();
  // Follow a changed title (an undo, another device) unless the owner has typed a different one.
  if (seen !== title) {
    setSeen(title);
    if (draft === seen) setDraft(title);
  }

  function save(): void {
    const parsed = schema.safeParse(draft);
    if (!parsed.success) {
      setError(TITLE_ERROR);
      setDraft(title);
      return;
    }
    setError("");
    setDraft(parsed.data);
    if (parsed.data !== title) onSave(parsed.data);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          aria-label={label}
          value={draft}
          maxLength={200}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="h-10 flex-1 border-transparent px-2 text-section hover:border-rule-2"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
        {aside}
      </div>
      {error ? (
        <p id={errorId} role="alert" className="px-2 text-tag text-ink-2">
          {error}
        </p>
      ) : null}
    </div>
  );
}
