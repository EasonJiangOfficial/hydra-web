import Link from "next/link";
import { cn } from "@/lib/utils";
import { HoverCard } from "./hover-card";
import { formatMoney } from "./money";

export type DayState = "hit" | "under" | "zero" | "future";

const STATE: Record<DayState, string> = {
  hit: "border-ink bg-ink text-white",
  under: "border-rule-2 bg-rule-2 text-ink",
  zero: "border-ink-3 bg-surface text-ink",
  future: "border-tint bg-tint text-ramp-4",
};

export type DayCellProps = {
  /** Day of month shown in the cell. */
  day: number;
  /** Full date for the hover card, e.g. "Nov 18". */
  date: string;
  posted: number;
  target: number;
  /** A day not yet reached. */
  future?: boolean;
  /** Signed cents: earned (positive) or missed (negative). */
  amountCents?: number;
  /** Extra hover lines after "N of M posted", e.g. one per deal ("Wordwise 0 of 2"). */
  lines?: readonly string[];
  /** Opens the day (e.g. `?day=2026-11-18`). */
  href?: string;
  className?: string;
};

export function dayState({ posted, target, future }: Pick<DayCellProps, "posted" | "target" | "future">): DayState {
  if (future) return "future";
  if (posted >= target && target > 0) return "hit";
  return posted > 0 ? "under" : "zero";
}

/** Posting calendar day: filled ink = target hit, gray = under, outlined = zero, tint = future. */
export function DayCell({ day, date, posted, target, future, amountCents, lines: extra = [], href, className }: DayCellProps) {
  const state = dayState({ posted, target, future });
  const lines = [
    date,
    future ? `Upcoming · target ${target}` : `${posted} of ${target} posted`,
    ...extra,
    !future && amountCents !== undefined && amountCents !== 0
      ? `${formatMoney(amountCents, { signed: true, whole: true })} ${amountCents > 0 ? "earned" : "missed"}`
      : null,
  ].filter(Boolean);
  const cls = cn(
    "grid h-[26px] min-w-0 place-items-center rounded-sm border text-tag tabular-nums transition-opacity duration-200 hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink",
    STATE[state],
    className,
  );
  const label = lines.join(", ");
  return (
    <HoverCard content={lines.join("\n")} describe={false}>
      {href ? (
        <Link href={href} scroll={false} aria-label={label} data-state-day={state} className={cls}>
          {day}
        </Link>
      ) : (
        <button type="button" aria-label={label} data-state-day={state} className={cls}>
          {day}
        </button>
      )}
    </HoverCard>
  );
}

/** Three 8 px swatches with 12 px labels. */
export function DayLegend({ className }: { className?: string }) {
  const items = [
    ["Hit", "bg-ink"],
    ["Under", "bg-rule-2"],
    ["Zero", "border border-ink-3"],
  ] as const;
  return (
    <div className={cn("flex items-center gap-3.5 text-tag text-ink-3", className)}>
      {items.map(([label, swatch]) => (
        <span key={label} className="flex items-center gap-1.5">
          <i aria-hidden className={cn("size-2 rounded-[2px]", swatch)} />
          {label}
        </span>
      ))}
    </div>
  );
}
