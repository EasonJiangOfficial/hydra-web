"use client";

import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useRef, useState } from "react";

import { Button, Seg, cn } from "@/components/kit";
import { Calendar } from "@/components/ui/calendar";
import { FIELD, Picker, PickerAnchor, PickerContent, usePhonePicker } from "@/components/ui/picker";

import { MAX_DAY, MIN_DAY, PERIODS, PERIOD_LABEL, customRange, periodAt, periodLabel, stepPeriod, type Period, type PeriodRange } from "./period";

const UNIT: Record<Exclude<Period, "custom">, string> = { daily: "day", weekly: "week", monthly: "month" };

/**
 * Daily / Weekly / Monthly / Custom. A fixed period steps with the arrows; Custom shows its From - To on a
 * button that opens the calendar, where two picks set the range. Switching keeps the day being looked at:
 * today when the period on screen holds it, else its first day.
 */
export function PeriodControl({
  value,
  today,
  zone,
  onChange,
  className,
}: {
  value: PeriodRange;
  today: string;
  zone: string;
  onChange: (next: PeriodRange) => void;
  className?: string;
}) {
  const pick = (v: string) => {
    const period = PERIODS.find((p) => p === v);
    if (!period || period === value.period) return;
    if (period === "custom") return onChange({ period, from: value.from, to: value.to });
    const anchor = value.from <= today && today <= value.to ? today : value.from;
    onChange(periodAt(period, anchor));
  };
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <Seg
        aria-label="Period"
        items={PERIODS.map((p) => ({ value: p, label: PERIOD_LABEL[p] }))}
        value={value.period}
        onValueChange={pick}
        className="max-sm:w-full max-sm:[&>*]:flex-1"
      />
      {value.period === "custom" ? (
        <RangePicker value={value} today={today} zone={zone} onChange={onChange} />
      ) : (
        <div className="flex items-center max-sm:w-full max-sm:justify-between">
          <Button variant="ghost" size="icon-sm" aria-label={`Earlier ${UNIT[value.period]}`} onClick={() => onChange(stepPeriod(value, -1))}>
            <ChevronLeft strokeWidth={1.5} />
          </Button>
          <span aria-live="polite" data-testid="period-label" className="min-w-[124px] text-center text-body font-medium tabular-nums">
            {periodLabel(value, today)}
          </span>
          <Button variant="ghost" size="icon-sm" aria-label={`Later ${UNIT[value.period]}`} onClick={() => onChange(stepPeriod(value, 1))}>
            <ChevronRight strokeWidth={1.5} />
          </Button>
        </div>
      )}
    </div>
  );
}

/** "Oct 30 – Nov 21" on a field-look button; the calendar takes the first day, then the last (in either order). */
function RangePicker({ value, today, zone, onChange }: { value: PeriodRange; today: string; zone: string; onChange: (r: PeriodRange) => void }) {
  const phone = usePhonePicker();
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const toggle = (next: boolean) => {
    setFirst(null);
    setOpen(next);
  };
  const label = periodLabel(value, today);
  return (
    <Picker open={open} onOpenChange={toggle} phone={phone}>
      <PickerAnchor>
        <button
          ref={button}
          type="button"
          aria-label={`Custom range, ${label}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid="period-range"
          onClick={() => toggle(!open)}
          className={cn(FIELD, "inline-flex h-8 items-center gap-2 px-3 tabular-nums hover:bg-tint focus-visible:border-ink")}
        >
          <CalendarDays aria-hidden strokeWidth={1.5} className="size-4 text-ink-3" />
          {label}
        </button>
      </PickerAnchor>
      <PickerContent
        label="Custom range"
        fallbackLabel="Custom range"
        anchor={button}
        focusOnClose={button}
        initialFocus={() => null}
        className={cn("overflow-y-auto", !phone && "w-auto min-w-0 p-1")}
      >
        <div className={cn("flex flex-col", phone && "self-center")}>
          <p aria-live="polite" className={cn("px-3 pt-2 text-label text-ink-3 tabular-nums", !first && "sr-only")}>
            {first ? `${periodLabel({ period: "custom", from: first, to: first }, today)} – …` : label}
          </p>
          <Calendar
            // Before the first pick the current range is shaded; after it, the first day stands alone.
            key={first ?? "range"}
            value={first ?? value.to}
            rangeStart={first ? undefined : value.from}
            timeZone={zone}
            today={today}
            clearable={false}
            min={MIN_DAY}
            max={MAX_DAY}
            weekStartsOn={1}
            large={phone}
            onPick={(day) => {
              if (!first) return setFirst(day);
              onChange(customRange(first, day));
              toggle(false);
            }}
          />
        </div>
      </PickerContent>
    </Picker>
  );
}
