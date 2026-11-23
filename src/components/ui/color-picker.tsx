"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LABEL_PALETTE, colorName, normalizeHex, pillColors } from "@/lib/label-colors";
import { cn } from "@/lib/utils";

const COLS = 6;

/**
 * The small round mark before a status or category name. Nothing when there is no color, or an
 * empty slot of the same size with `reserve`, so a select beside it does not shift.
 */
export function ColorDot({ color, className, reserve = false }: { color: string | null | undefined; className?: string; reserve?: boolean }) {
  if (!color) return reserve ? <span aria-hidden className={cn("size-2 shrink-0", className)} /> : null;
  return <span aria-hidden data-color-dot={color.toLowerCase()} className={cn("size-2 shrink-0 rounded-full", className)} style={{ background: color }} />;
}

/** A tag (select option) pill: a light tint of its color with readable text. Plain text without a color. */
export function ColorPill({ color, children, className }: { color: string | null | undefined; children: ReactNode; className?: string }) {
  return (
    <span
      data-slot="color-pill"
      data-color={color?.toLowerCase()}
      className={cn("inline-flex max-w-full items-center truncate rounded px-1.5 py-px text-tag font-medium whitespace-nowrap", !color && "text-ink-2", className)}
      style={color ? pillColors(color) : undefined}
    >
      {children}
    </span>
  );
}

/**
 * Picks a label color: 18 swatches in rows of six (arrows move, Enter picks, Escape closes), the picked one
 * ringed, its name under the grid on hover or focus, and a hex field for any other color.
 * `allowNone` adds "None" (categories may have no color; they then keep the gray ramp).
 */
export function ColorPicker({
  value,
  onChange,
  label,
  allowNone = false,
  disabled,
  className,
}: {
  value: string | null;
  onChange: (hex: string | null) => void;
  /** What is colored, for the trigger's name: "Blocked" gives "Color for Blocked". */
  label: string;
  allowNone?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const swatches = useRef<(HTMLButtonElement | null)[]>([]);
  const current = value?.toLowerCase() ?? null;
  const picked = LABEL_PALETTE.findIndex((c) => c.hex === current);

  const pick = (hex: string | null) => {
    setOpen(false);
    if (hex !== current) onChange(hex);
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = swatches.current.findIndex((b) => b === document.activeElement);
    if (at < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const n = LABEL_PALETTE.length;
    swatches.current[(at + step + n) % n]?.focus();
  };

  const customHex = normalizeHex(custom);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setHover(null);
        setCustom(current && picked < 0 ? current : "");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Color for ${label}: ${colorName(current)}`}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className={cn(
            // 24 px target (WCAG 2.5.8); on touch an invisible ring grows the hit area to 40 px.
            "relative grid size-6 shrink-0 place-items-center rounded-full outline-none pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-[''] transition-colors duration-200 hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-40",
            className,
          )}
        >
          {current ? (
            <span aria-hidden className="size-2.5 rounded-full" style={{ background: current }} />
          ) : (
            <span aria-hidden className="size-2.5 rounded-full border border-dashed border-ink-3" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto gap-3 p-3"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          swatches.current[Math.max(0, picked)]?.focus();
        }}
      >
        <div role="radiogroup" aria-label={`Color for ${label}`} className="grid grid-cols-6 gap-2" onKeyDown={onGridKey}>
          {LABEL_PALETTE.map((c, i) => (
            <button
              key={c.hex}
              ref={(el) => {
                swatches.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={i === picked}
              aria-label={c.name}
              tabIndex={i === Math.max(0, picked) ? 0 : -1}
              onClick={() => pick(c.hex)}
              onMouseEnter={() => setHover(c.name)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(c.name)}
              className={cn(
                "size-6 rounded-full outline-none transition-[box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-ink-3 focus-visible:ring-offset-2",
                i === picked ? "ring-2 ring-ink ring-offset-2" : "hover:ring-1 hover:ring-rule-2 hover:ring-offset-2",
              )}
              style={{ background: c.hex }}
            />
          ))}
        </div>
        {/* Sighted users only: each swatch's radio already announces its name. */}
        <span className="h-4 text-label text-ink-3" aria-hidden>
          {hover ?? colorName(current)}
        </span>
        <form
          className="flex items-center gap-2 border-t border-rule pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (customHex) pick(customHex);
          }}
        >
          <span aria-hidden className="size-4 shrink-0 rounded-full border border-rule" style={customHex ? { background: customHex } : undefined} />
          <input
            aria-label="Custom color"
            placeholder="Custom #hex"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            maxLength={7}
            spellCheck={false}
            aria-invalid={custom !== "" && !customHex}
            className="h-8 w-28 min-w-0 rounded-lg border border-rule-2 bg-surface px-2.5 text-label text-ink tabular-nums outline-none transition-colors duration-200 placeholder:text-ink-3 focus:border-ink"
          />
          {allowNone ? (
            <button
              type="button"
              onClick={() => pick(null)}
              aria-pressed={current === null}
              className="ml-auto rounded-md px-1.5 py-1 text-label text-ink-3 outline-none transition-colors duration-200 hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
            >
              None
            </button>
          ) : null}
        </form>
      </PopoverContent>
    </Popover>
  );
}
