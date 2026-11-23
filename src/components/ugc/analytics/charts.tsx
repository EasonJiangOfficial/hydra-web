"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";

import { Button, Skeleton, cn } from "@/components/kit";
import { intensity, weeksOf, type ViewsByDeal } from "@/lib/ugc/analytics";
import type { DayBucket } from "@/lib/ugc/posting-consistency";
import { formatCompactCount } from "@/lib/ugc/format-views";

import { monthLabel, shiftMonth, shortDay } from "../model";

/** The kit's gray ramp in the order it paints series (src/components/kit/charts.tsx). */
export const RAMP = ["var(--ramp-1)", "var(--ramp-3)", "var(--ramp-4)", "var(--ramp-2)", "var(--ramp-5)", "var(--ramp-6)"];

export const compact = (n: number) => formatCompactCount(Math.round(n)).replace(/\.0(?=[KMB]$)/, "");

/** The kit's chart tooltip look (ink panel, first line gray). */
export function Tip({ lines }: { lines: ReactNode[] }) {
  return (
    <div className="rounded-lg bg-ink px-2.5 py-2 text-tag leading-[1.45] whitespace-nowrap text-white tabular-nums animate-in fade-in-0 slide-in-from-bottom-1 duration-140">
      {lines.map((l, i) => (
        <div key={i} className={i === 0 ? "text-ink-on-dark-3" : undefined}>
          {l}
        </div>
      ))}
    </div>
  );
}

/**
 * A block that shows its skeleton until it nears the viewport, then fades its content in (150 ms).
 * The charts inside draw once on first view, like the kit's.
 */
export function Reveal({ height, className, children }: { height: number; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, margin: "160px 0px" });
  return (
    // data-lazy: the page's loading bar does not wait for a skeleton that waits for a scroll.
    <div ref={ref} className={cn("min-w-0", className)} data-analytics-block={seen ? "ready" : "loading"} data-lazy={seen ? undefined : ""}>
      {seen ? (
        <div className="h-full animate-in fade-in-0 duration-150">{children}</div>
      ) : (
        <div aria-hidden className="flex flex-col gap-3 rounded-xl border border-rule p-6 max-md:p-4" style={{ minHeight: height }}>
          <Skeleton className="h-[17px] w-28 rounded-sm" />
          <Skeleton className="w-full flex-1" />
        </div>
      )}
    </div>
  );
}

type TipProps = TooltipContentProps<ValueType, NameType>;

/** Views per posting day, one ink-to-gray line per deal. Draws in once. `fit` scales the axis to the data instead of from 0 (followers). */
export function ViewsLines({
  data,
  height = 220,
  fit = false,
  label = "Views by deal",
}: {
  data: ViewsByDeal;
  height?: number;
  fit?: boolean;
  label?: string;
}) {
  const reduced = useReducedMotion();
  const rows = data.days.map((d) => Object.fromEntries([["label", shortDay(d.day)], ...d.values.map((v, i) => [`d${i}`, v])]));
  return (
    <div role="img" aria-label={label} className="relative w-full min-w-0" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height }}>
        <LineChart accessibilityLayer={false} data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--rule)" />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--ink-3)", fontSize: 12 }}
            tickMargin={8}
            interval="preserveStartEnd"
            minTickGap={48}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--ink-3)", fontSize: 12 }}
            width={fit ? 48 : 40}
            tickFormatter={fit ? (n: number) => n.toLocaleString("en-US") : compact}
            allowDecimals={false}
            domain={fit ? ["auto", "auto"] : undefined}
          />
          <Tooltip
            isAnimationActive={false}
            wrapperStyle={{ outline: "none", zIndex: 30 }}
            cursor={{ stroke: "var(--ink)", strokeOpacity: 0.2, strokeWidth: 1 }}
            content={({ active, payload, label }: TipProps) =>
              active && payload?.length ? (
                <Tip lines={[label, ...payload.map((p, i) => `${data.deals[i]?.name ?? ""} ${Number(p.value).toLocaleString("en-US")}`)]} />
              ) : null
            }
          />
          {data.deals.map((d, i) => (
            <Line
              key={d.id}
              dataKey={`d${i}`}
              name={d.name}
              type="monotone"
              stroke={RAMP[i % RAMP.length]}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, stroke: "none", fill: RAMP[i % RAMP.length] }}
              isAnimationActive={!reduced}
              animationDuration={900}
              animationEasing="ease-out"
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

const SHADE = ["bg-tint border border-rule", "bg-ramp-5", "bg-ramp-4", "bg-ramp-3", "bg-ink"] as const;
const CELL = 11;
const GAP = 3;

/** Ripple's year heatmap (components/dashboard/ConsistencyHeatmap.tsx) in the gray ramp. Hover names the day. */
export function YearHeatmap({ days }: { days: readonly DayBucket[] }) {
  const weeks = weeksOf(days);
  const [hover, setHover] = useState<DayBucket | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Open on the latest weeks when the year is wider than the card (phone).
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);
  const months = weeks.map((w) => {
    const first = w.find((d) => d && d.date.endsWith("-01"));
    return first ? new Date(`${first.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }) : "";
  });
  return (
    <div className="flex flex-col gap-2">
      <div ref={scroller} className="overflow-x-auto pb-1">
        <div className="flex min-w-[640px] flex-col" style={{ gap: GAP }} role="grid" aria-label="Posting consistency, last 365 days" onMouseLeave={() => setHover(null)}>
          <div className="flex text-tag text-ink-3" style={{ gap: GAP, height: 16 }} aria-hidden>
            {months.map((m, i) => (
              <span key={i} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
                {m}
              </span>
            ))}
          </div>
          <div className="flex" style={{ gap: GAP }}>
            {weeks.map((w, i) => (
              <div key={i} className="flex min-w-0 flex-1 flex-col" style={{ gap: GAP }} role="row">
                {w.map((d, j) =>
                  d ? (
                    <span
                      key={d.date}
                      role="gridcell"
                      aria-label={`${shortDay(d.date)}, ${d.count} ${d.count === 1 ? "platform" : "platforms"}`}
                      data-count={d.count}
                      onMouseEnter={() => setHover(d)}
                      className={cn("aspect-square w-full rounded-[2px] transition-opacity duration-200 hover:opacity-70", SHADE[intensity(d.count)])}
                    />
                  ) : (
                    <span key={`x${j}`} aria-hidden className="aspect-square w-full" />
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 text-tag text-ink-3">
        <span aria-live="polite" className="min-h-4 tabular-nums">
          {hover ? `${shortDay(hover.date)} · ${hover.count === 0 ? "No posts" : `${hover.count} ${hover.count === 1 ? "platform" : "platforms"}`}` : ""}
        </span>
        <span className="flex-1" />
        <span>Less</span>
        {SHADE.map((s, i) => (
          <span key={i} aria-hidden className={cn("rounded-[2px]", s)} style={{ width: CELL, height: CELL }} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

/**
 * One month of a day series, Sunday first (Ripple components/dashboard/MonthDayGrid.tsx). Darker is more.
 * Days outside the range show a dash.
 */
export function MonthSeries({
  series,
  format,
  unit,
  defaultMonth,
}: {
  series: readonly { day: string; value: number }[];
  format: (n: number) => string;
  unit: string;
  defaultMonth: string;
}) {
  const months = [...new Set(series.map((s) => s.day.slice(0, 7)))];
  const [month, setMonth] = useState(defaultMonth);
  const shown = months.includes(month) ? month : (months.at(-1) ?? defaultMonth);
  const by = new Map(series.map((s) => [s.day, s.value]));
  const [y, m] = shown.split("-").map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const max = Math.max(1, ...series.filter((s) => s.day.startsWith(shown)).map((s) => s.value));
  const i = months.indexOf(shown);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" aria-label="Previous month" disabled={i <= 0} onClick={() => setMonth(shiftMonth(shown, -1))}>
          <ChevronLeft strokeWidth={1.5} />
        </Button>
        <span aria-live="polite" className="flex-1 text-center text-body font-medium">
          {monthLabel(shown)}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Next month" disabled={i < 0 || i >= months.length - 1} onClick={() => setMonth(shiftMonth(shown, 1))}>
          <ChevronRight strokeWidth={1.5} />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-1" role="grid" aria-label={`${unit} per day, ${monthLabel(shown)}`}>
        {["M", "T", "W", "T", "F", "S", "S"].map((w, k) => (
          <span key={k} aria-hidden className="text-center text-tag text-ink-3">
            {w}
          </span>
        ))}
        {Array.from({ length: lead }, (_, k) => (
          <span key={`b${k}`} aria-hidden />
        ))}
        {Array.from({ length: count }, (_, k) => {
          const day = `${shown}-${String(k + 1).padStart(2, "0")}`;
          const v = by.get(day);
          const level = v === undefined || v <= 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4));
          return (
            <span
              key={day}
              role="gridcell"
              title={v === undefined ? `${shortDay(day)}` : `${shortDay(day)} · ${format(v)} ${unit}`}
              aria-label={v === undefined ? `${shortDay(day)}, outside the range` : `${shortDay(day)}, ${format(v)} ${unit}`}
              className={cn(
                "grid h-8 place-items-center rounded-sm text-tag tabular-nums",
                v === undefined ? "text-ink-3/60" : level >= 3 ? "text-white" : "text-ink-2",
                v === undefined ? "bg-transparent" : SHADE[level],
              )}
            >
              {v === undefined ? "–" : k + 1}
            </span>
          );
        })}
      </div>
    </div>
  );
}
