"use client";

import { useState, type ReactNode } from "react";

import { Button } from "@/components/kit";

/**
 * Every deletion asks first (DESIGN.md, Hydra Agent safety). One click shows the question with Keep
 * and the real button; nothing is removed until the second click.
 */
export function ConfirmButton({
  label,
  question,
  confirmLabel,
  onConfirm,
  className,
  variant = "ghost",
}: {
  label: ReactNode;
  question: ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  className?: string;
  variant?: "ghost" | "outline";
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking)
    return (
      <Button variant={variant} className={className ?? "text-ink-3"} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  return (
    <span role="group" aria-label="Confirm" className="flex flex-wrap items-center gap-2">
      <span className="text-label text-ink-3">{question}</span>
      <Button variant="ghost" onClick={() => setAsking(false)}>
        Keep
      </Button>
      <Button
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setAsking(false);
          }
        }}
      >
        {confirmLabel}
      </Button>
    </span>
  );
}
