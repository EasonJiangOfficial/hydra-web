"use client";

import { useRoutines } from "./store";

/** The one status line: at the top of the page, and inside the panel while it covers the page. */
export function Notice() {
  const { notice, say } = useRoutines();
  if (!notice) return null;
  return (
    <div role="status" className="flex items-start gap-3 rounded-lg bg-tint px-3.5 py-2.5 text-body">
      <span className="min-w-0 flex-1">{notice}</span>
      <button type="button" onClick={() => say(null)} className="text-label text-ink-3 underline underline-offset-2 hover:text-ink">
        Dismiss
      </button>
    </div>
  );
}
