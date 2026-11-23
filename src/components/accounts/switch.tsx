"use client";

import { useState } from "react";

import { cn } from "@/components/kit";

/** On/off switch: ink track when on, outlined when off. A button with role=switch; 200 ms ease. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-200 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40",
        checked ? "border-ink bg-ink" : "border-rule-2 bg-surface",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-1/2 left-0.5 size-3.5 -translate-y-1/2 rounded-full transition-[transform,background-color] duration-200",
          checked ? "translate-x-4 bg-white" : "bg-ink-3",
        )}
      />
    </button>
  );
}

/** Local copy of a saved value that follows the saved value when it changes (an undo, a refresh). */
export function useSynced<T>(value: T) {
  const [local, setLocal] = useState(value);
  const [seen, setSeen] = useState(value);
  if (!Object.is(seen, value)) {
    setSeen(value);
    setLocal(value);
  }
  return [local, setLocal] as const;
}
