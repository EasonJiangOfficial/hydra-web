"use client";

import { useState, type ComponentProps, type ReactNode } from "react";

import { Button, Input, Label, cn } from "@/components/kit";
import { LOGO_TYPES } from "@/lib/ugc/logo";
import type { ActionResult } from "@/lib/ugc/schemas";

/** Runs a write and keeps its state: busy while it runs, the server's message when it is refused. */
export function useAct() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act<T>(fn: () => Promise<ActionResult<T>>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        setError(res.error.message);
        return undefined;
      }
      return res.data;
    } catch {
      setError("Could not save. Try again.");
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, act, clear: () => setError(null) };
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-tag text-ink-2">
      {children}
    </p>
  );
}

/**
 * Every deletion asks first (owner, 2026-11-22). The first click swaps the button for the question;
 * nothing is sent until the second click. `what` names the thing in the question.
 */
export function ConfirmDelete({
  what,
  label = "Delete",
  confirmLabel = "Delete",
  onConfirm,
  busy,
  className,
  ariaLabel,
}: {
  what: string;
  /** The first button's accessible name, when its text alone is ambiguous in a list. */
  ariaLabel?: string;
  label?: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button variant="ghost" aria-label={ariaLabel} className={cn("text-ink-3", className)} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  }
  return (
    <div role="group" aria-label={`Confirm ${label.toLowerCase()}`} className={cn("flex flex-wrap items-center gap-2", className)}>
      <span className="text-label text-ink-3">{what}?</span>
      <Button variant="ghost" onClick={() => setAsking(false)} disabled={busy}>
        Cancel
      </Button>
      <Button
        variant="outline"
        disabled={busy}
        onClick={async () => {
          await onConfirm();
          setAsking(false);
        }}
      >
        {confirmLabel}
      </Button>
    </div>
  );
}

/** A deal's logo from the private bucket (a signed URL), or its initials on a tint square. */
export function DealLogo({ name, url, size = 36 }: { name: string; url: string | null; size?: number }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const style = { width: size, height: size };
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL; next/image would proxy and cache it
    <img src={url} alt="" aria-hidden style={style} className="shrink-0 rounded-md bg-tint object-cover" />
  ) : (
    <span
      aria-hidden
      style={style}
      className="grid shrink-0 place-items-center rounded-md border border-rule bg-surface text-tag font-medium text-ink-2"
    >
      {initials}
    </span>
  );
}

/** "Add logo" / "Change logo": a button that opens the file picker for a logo image. */
export function LogoPicker({ hasLogo, onFile, disabled }: { hasLogo: boolean; onFile: (file: File) => void; disabled?: boolean }) {
  const text = hasLogo ? "Change logo" : "Add logo";
  return (
    <label
      className={cn(
        "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-lg px-2 text-tag whitespace-nowrap text-ink-3 transition-colors duration-200 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink hover:bg-tint hover:text-ink",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      <input
        type="file"
        accept={Object.keys(LOGO_TYPES).join(",")}
        className="sr-only"
        disabled={disabled}
        aria-label={text}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onFile(file);
        }}
      />
      {text}
    </label>
  );
}

/** Gray label above a control. */
export function Field({
  label,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label as="label" htmlFor={htmlFor}>
        {label}
      </Label>
      {children}
    </div>
  );
}

/** A dollar amount typed as text: "$" sits inside the box. */
export function DollarInput({ className, ...props }: ComponentProps<"input">) {
  return (
    <span className={cn("relative block min-w-0", className)}>
      <span aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-body text-ink-3">
        $
      </span>
      <Input inputMode="decimal" className="pl-6 tabular-nums" {...props} />
    </span>
  );
}

/** A small outlined toggle (aria-pressed): a lane on or off. */
export function Toggle({
  pressed,
  onPressedChange,
  children,
  className,
}: {
  pressed: boolean;
  onPressedChange: (v: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "h-[34px] rounded-lg border px-3.5 text-body whitespace-nowrap transition-colors duration-200 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
        pressed ? "border-ink bg-tint font-medium text-ink" : "border-rule-2 text-ink-3 hover:bg-tint hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * A segmented control in the kit's look without its sliding thumb. The kit's Seg animates the thumb with a
 * shared `layoutId`, which throws when it mounts inside the drawer's or the wizard's own animated container;
 * here the picked item simply gets the outlined white thumb.
 */
export function PlainSeg({
  items,
  value,
  onValueChange,
  "aria-label": label,
  className,
}: {
  items: readonly { value: string; label: ReactNode }[];
  value: string;
  onValueChange: (v: string) => void;
  "aria-label": string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex max-w-full shrink-0 rounded-lg bg-tint p-0.5", className)}>
      {items.map((item) => {
        const on = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onValueChange(item.value)}
            className={cn(
              "h-7 rounded-md border px-3 text-label whitespace-nowrap transition-colors duration-200 outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink",
              on ? "border-rule-2 bg-surface font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** A section title inside a panel or card. */
export function SectionLabel({ children, aside, strong }: { children: ReactNode; aside?: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <Label className={cn("flex-1", strong && "text-body font-medium text-ink")}>{children}</Label>
      {aside}
    </div>
  );
}
