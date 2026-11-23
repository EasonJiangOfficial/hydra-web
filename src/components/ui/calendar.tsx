"use client";

import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import {
  clampDay,
  firstOfMonth,
  formatDay,
  formatMonth,
  inRange,
  isIsoDay,
  lastOfMonth,
  monthGrid,
  sameMonth,
  shiftDays,
  shiftMonths,
  toDay,
  todayDay,
} from "@/lib/date-input";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The day a key moves to, or null when the key is not a calendar key. Shift+PageUp/PageDown moves a year. */
export function calendarKey(key: string, shift: boolean, day: string, weekStartsOn: 0 | 1 = 0): string | null {
  const dow = (toDay(day)!.getDay() + 7 - weekStartsOn) % 7;
  switch (key) {
    case "ArrowLeft":
      return shiftDays(day, -1);
    case "ArrowRight":
      return shiftDays(day, 1);
    case "ArrowUp":
      return shiftDays(day, -7);
    case "ArrowDown":
      return shiftDays(day, 7);
    case "Home":
      return shiftDays(day, -dow);
    case "End":
      return shiftDays(day, 6 - dow);
    case "PageUp":
      return shiftMonths(day, shift ? -12 : -1);
    case "PageDown":
      return shiftMonths(day, shift ? 12 : 1);
  }
  return null;
}

const ICON_BTN =
  "inline-grid place-items-center rounded-md text-ink-3 outline-none transition-colors duration-200 hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-30";

export type CalendarProps = {
  /** The picked day, `yyyy-mm-dd`, or "". */
  value: string;
  onPick: (day: string) => void;
  /** Today (`yyyy-mm-dd`); by default read from the clock in `timeZone` when the calendar mounts. */
  today?: string;
  /** The owner's zone (settings.time_zone). */
  timeZone?: string;
  min?: string;
  max?: string;
  /** The other end of a start/end pair: the days between it and the picked day are shaded. */
  rangeStart?: string;
  rangeEnd?: string;
  /** Shows Clear. */
  clearable?: boolean;
  /** Focus the picked day (or today) on mount. */
  autoFocus?: boolean;
  /** 44 px days for phones. */
  large?: boolean;
  /** 0 = weeks start Sunday (default), 1 = Monday. */
  weekStartsOn?: 0 | 1;
  onEscape?: () => void;
};

/**
 * Month calendar: weekday header, today marked with a dot, picked day filled ink, other-month days muted,
 * previous and next month, a month and year jump (click the title), Today and Clear. Arrow keys move a
 * day or a week, Home and End to the week's ends, PageUp and PageDown a month (with Shift a year), Enter
 * or Space picks. Days outside min and max are off.
 */
export function Calendar({ value, onPick, today: todayProp, timeZone, min, max, rangeStart, rangeEnd, clearable = true, autoFocus, large, weekStartsOn = 0, onEscape }: CalendarProps) {
  // The calendar only mounts once opened, so reading the clock here never runs in a prerender.
  const [today] = useState(() => todayProp ?? todayDay(timeZone));
  const other = rangeStart ?? rangeEnd;
  const start = clampDay(isIsoDay(value) ? value : isIsoDay(other) ? other : today, min, max);
  const [focused, setFocused] = useState(start);
  const [view, setView] = useState(firstOfMonth(start));
  const [mode, setMode] = useState<"days" | "months">("days");
  const grid = useRef<HTMLDivElement>(null);
  const wantFocus = useRef(!!autoFocus);

  useEffect(() => {
    if (!wantFocus.current || mode !== "days") return;
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focused}"]`)?.focus({ preventScroll: true });
  }, [focused, view, mode]);

  const moveTo = (day: string) => {
    const next = clampDay(day, min, max);
    wantFocus.current = true;
    setFocused(next);
    if (!sameMonth(next, view)) setView(firstOfMonth(next));
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = calendarKey(e.key, e.shiftKey, focused, weekStartsOn);
    if (next) {
      e.preventDefault();
      moveTo(next);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (inRange(focused, min, max)) onPick(focused);
    } else if (e.key === "Escape" && onEscape) {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    }
  };

  const prevOff = !!min && lastOfMonth(shiftMonths(view, -1)) < min;
  const nextOff = !!max && shiftMonths(view, 1) > max;
  const year = Number(view.slice(0, 4));
  const lo = rangeStart && isIsoDay(value) ? rangeStart : value;
  const hi = rangeEnd && isIsoDay(value) ? rangeEnd : value;
  const cell = large ? "size-11 text-tab" : "size-9 text-body";
  const todayOk = inRange(today, min, max);

  const stepView = (n: number) => {
    const next = shiftMonths(view, n);
    setView(next);
    setFocused(clampDay(sameMonth(focused, next) ? focused : next, min, max));
  };

  return (
    <div className="flex flex-col gap-1 p-1" data-slot="calendar">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={mode === "days" ? "Choose month and year" : "Back to days"}
          aria-expanded={mode === "months"}
          onClick={() => setMode(mode === "days" ? "months" : "days")}
          className={cn(
            "mr-auto inline-flex items-center gap-1 rounded-md px-2 font-medium text-ink outline-none transition-colors duration-200 hover:bg-tint focus-visible:outline-2 focus-visible:outline-ink",
            large ? "h-11 text-tab" : "h-8 text-body",
          )}
        >
          {mode === "days" ? formatMonth(view) : year}
          <ChevronDown aria-hidden strokeWidth={1.5} className={cn("pointer-events-none size-4 text-ink-3 transition-transform duration-200", mode === "months" && "rotate-180")} />
        </button>
        <button
          type="button"
          aria-label={mode === "days" ? "Previous month" : "Previous year"}
          disabled={mode === "days" ? prevOff : !!min && `${year - 1}-12-31` < min}
          onClick={() => (mode === "days" ? stepView(-1) : setView(shiftMonths(view, -12)))}
          className={cn(ICON_BTN, large ? "size-11" : "size-8")}
        >
          <ChevronLeft aria-hidden strokeWidth={1.5} className="pointer-events-none size-4" />
        </button>
        <button
          type="button"
          aria-label={mode === "days" ? "Next month" : "Next year"}
          disabled={mode === "days" ? nextOff : !!max && `${year + 1}-01-01` > max}
          onClick={() => (mode === "days" ? stepView(1) : setView(shiftMonths(view, 12)))}
          className={cn(ICON_BTN, large ? "size-11" : "size-8")}
        >
          <ChevronRight aria-hidden strokeWidth={1.5} className="pointer-events-none size-4" />
        </button>
      </div>

      {mode === "months" ? (
        <div role="group" aria-label={`Months of ${year}`} className="grid grid-cols-3 gap-1" style={{ width: large ? undefined : "252px" }}>
          {MONTHS.map((m, i) => {
            const first = `${year}-${String(i + 1).padStart(2, "0")}-01`;
            const off = (!!max && first > max) || (!!min && lastOfMonth(first) < min);
            const here = sameMonth(first, view);
            return (
              <button
                key={m}
                type="button"
                disabled={off}
                aria-pressed={here}
                onClick={() => {
                  setView(first);
                  setFocused(clampDay(`${first.slice(0, 8)}${String(Math.min(Number(focused.slice(8)), Number(lastOfMonth(first).slice(8)))).padStart(2, "0")}`, min, max));
                  setMode("days");
                  wantFocus.current = true;
                }}
                className={cn(
                  "rounded-lg outline-none transition-colors duration-200 hover:bg-tint focus-visible:outline-2 focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-30",
                  large ? "h-14 text-tab" : "h-11 text-body",
                  here && "bg-ink text-white hover:bg-ink",
                )}
              >
                {m}
              </button>
            );
          })}
        </div>
      ) : (
        <div ref={grid} role="grid" aria-label={formatMonth(view)} onKeyDown={onGridKey} className={cn(large && "self-center")}>
          <div role="row" className="grid grid-cols-7">
            {[...WEEKDAYS.slice(weekStartsOn), ...WEEKDAYS.slice(0, weekStartsOn)].map((w) => (
              <span key={w} role="columnheader" aria-label={w} className={cn("grid place-items-center text-tag text-ink-3", large ? "h-8 w-11" : "h-7 w-9")}>
                {w}
              </span>
            ))}
          </div>
          {Array.from({ length: 6 }, (_, r) => (
            <div key={r} role="row" className="grid grid-cols-7">
              {monthGrid(view, weekStartsOn)
                .slice(r * 7, r * 7 + 7)
                .map((day) => {
                  const picked = day === value;
                  const off = !inRange(day, min, max);
                  const outside = !sameMonth(day, view);
                  const shaded = !!other && isIsoDay(value) && day > lo && day < hi;
                  const end = !!other && day === other;
                  return (
                    <span key={day} role="gridcell" aria-selected={picked} className={cn("grid place-items-center", shaded && "bg-tint", day === lo && other && "rounded-l-lg bg-tint", day === hi && other && "rounded-r-lg bg-tint")}>
                      <button
                        type="button"
                        data-day={day}
                        tabIndex={day === focused ? 0 : -1}
                        aria-label={`${formatDay(day)}${day === today ? ", today" : ""}`}
                        aria-current={day === today ? "date" : undefined}
                        aria-disabled={off || undefined}
                        onClick={() => !off && onPick(day)}
                        onFocus={() => day !== focused && setFocused(day)}
                        className={cn(
                          "relative grid place-items-center rounded-lg tabular-nums outline-none transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink",
                          cell,
                          outside ? "text-ramp-4" : "text-ink",
                          !picked && !off && "hover:bg-hover",
                          end && !picked && "border border-ink",
                          picked && "bg-ink font-medium text-white",
                          off && "cursor-not-allowed text-rule-2 line-through decoration-rule-2",
                        )}
                      >
                        {Number(day.slice(8))}
                        {day === today ? (
                          <span aria-hidden className={cn("absolute bottom-1 size-1 rounded-full", picked ? "bg-white" : "bg-ink")} />
                        ) : null}
                      </button>
                    </span>
                  );
                })}
            </div>
          ))}
        </div>
      )}

      <div className="mt-1 flex items-center gap-1 border-t border-rule pt-1">
        <button
          type="button"
          disabled={!todayOk}
          onClick={() => onPick(today)}
          className={cn("rounded-md px-2 text-label font-medium text-ink outline-none transition-colors duration-200 hover:bg-tint focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-30", large ? "h-11" : "h-7")}
        >
          Today
        </button>
        {clearable ? (
          <button
            type="button"
            onClick={() => onPick("")}
            className={cn("ml-auto rounded-md px-2 text-label text-ink-3 outline-none transition-colors duration-200 hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-ink", large ? "h-11" : "h-7")}
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}
