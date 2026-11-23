"use client";

import { Popover } from "radix-ui";
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const OPEN_DELAY = 80; // --delay-hover-card
const LONG_PRESS = 450;

export type HoverCardProps = {
  /** What the panel shows. Plain text keeps its line breaks. */
  content: ReactNode;
  /** The trigger. Must be one element that accepts a ref and pointer handlers. */
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /** Classes for the ink panel (width, padding). */
  className?: string;
  /** Expose `content` as the trigger's accessible description. Off when the trigger's name already says it all. */
  describe?: boolean;
};

/**
 * Ink panel for chart marks, calendar days and rows. Desktop: opens on hover after 80 ms and
 * rises 4 px while it fades in over 140 ms. Touch: tap or long-press toggles it; a tap outside
 * closes it. Keyboard: opens while the trigger has visible focus. The trigger keeps its own clicks.
 * The content is the trigger's accessible description: the panel while open, a hidden copy while closed.
 */
export function HoverCard({ content, children, side = "top", align = "center", className, describe = true }: HoverCardProps) {
  const [open, setOpen] = useState(false);
  const descId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointer = useRef<string>("mouse");
  const longPressed = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);

  const later = (fn: () => void, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor
        asChild
        aria-expanded={open}
        aria-describedby={describe ? descId : undefined}
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") later(() => setOpen(true), OPEN_DELAY);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType !== "mouse") return;
          clearTimeout(timer.current);
          setOpen(false);
        }}
        onPointerDown={(e) => {
          pointer.current = e.pointerType;
          longPressed.current = false;
          if (e.pointerType !== "mouse")
            later(() => {
              longPressed.current = true;
              setOpen(true);
            }, LONG_PRESS);
        }}
        onPointerUp={() => {
          if (pointer.current !== "mouse") clearTimeout(timer.current);
        }}
        onClick={() => {
          if (pointer.current !== "mouse" && !longPressed.current) setOpen((o) => !o);
        }}
        onFocus={(e) => {
          if (e.currentTarget.matches(":focus-visible")) setOpen(true);
        }}
        onBlur={() => setOpen(false)}
      >
        {children}
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          id={describe ? descId : undefined}
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className={cn(
            "pointer-events-none z-[70] max-w-[calc(100vw-16px)] rounded-lg bg-ink px-2.5 py-2 text-tag leading-[1.45] font-normal whitespace-pre-line text-white outline-none",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-140",
            "data-[side=top]:slide-in-from-bottom-1 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-100",
            className,
          )}
        >
          {content}
        </Popover.Content>
      </Popover.Portal>
      {/* display:none after the trigger: no layout, no first: shift; aria-describedby still reads it. */}
      {describe && !open && (
        <span id={descId} hidden className="whitespace-pre-line">
          {content}
        </span>
      )}
    </Popover.Root>
  );
}

export type InfoDotProps = {
  /** The explanation the page must not print. */
  children: ReactNode;
  /** Accessible name of the dot. */
  label?: string;
  className?: string;
};

/** 18 px outlined "i" with a 32 px hit area. Hover (desktop) or tap (phone) shows a 280 px ink panel with the explanation. */
export function InfoDot({ children, label = "More info", className }: InfoDotProps) {
  return (
    <HoverCard content={children} className="w-[280px] px-3.5 py-3">
      <button
        type="button"
        aria-label={label}
        data-slot="info-dot"
        className={cn(
          // The ::after ring widens the tap target to 32 px without moving the layout.
          "relative inline-grid size-[18px] shrink-0 cursor-help place-items-center rounded-full after:absolute after:-inset-2 after:rounded-full after:content-[''] border border-rule-2 bg-surface text-[11px] leading-none font-medium tracking-normal text-ink-3 transition-colors duration-200 hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
          className,
        )}
      >
        i
      </button>
    </HoverCard>
  );
}
