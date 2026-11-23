"use client";

import { motion, useInView, useReducedMotion } from "motion/react";
import { useRef, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar as RBar,
  BarChart,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  Rectangle,
  ResponsiveContainer,
  Sankey as RSankey,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import { cn } from "@/lib/utils";
import { formatMoney, type MoneyFormat } from "./money";
import { EASE } from "./seg";

/* Charts draw in once, the first time they scroll into view, and never replay on hover.
   Under reduced motion they appear drawn. Tooltips use the HoverCard look.
   Each chart is one role=img with an aria-label; accessibilityLayer is off so no focusable application sits inside it. */

const RAMP = ["var(--ramp-1)", "var(--ramp-3)", "var(--ramp-4)", "var(--ramp-2)", "var(--ramp-5)", "var(--ramp-6)"];
const plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function fmt(v: number, money?: MoneyFormat) {
  return money ? formatMoney(v, money) : plain.format(v);
}

function useFirstView() {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.2 });
  return [ref, seen] as const;
}

function Frame({
  height,
  label,
  className,
  width,
  children,
}: {
  /** px, or any CSS length such as "100%" to fill a sized parent. */
  height: number | string;
  width?: number;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const [ref, seen] = useFirstView();
  return (
    // Nothing inside is a tab stop, but a tap can still focus a recharts layer: no outline box around the bars.
    <div ref={ref} role="img" aria-label={label} className={cn("relative w-full min-w-0 [&_*:focus]:outline-none", className)} style={{ height, maxWidth: width }}>
      {seen && (
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: typeof height === "number" ? height : 1 }}>
          {children as React.ReactElement}
        </ResponsiveContainer>
      )}
    </div>
  );
}

/** The HoverCard look for chart tooltips. */
function Tip({ lines }: { lines: ReactNode[] }) {
  return (
    <div className="rounded-lg bg-ink px-2.5 py-2 text-tag leading-[1.45] whitespace-nowrap text-white tabular-nums animate-in fade-in-0 slide-in-from-bottom-1 duration-140">
      {lines.filter((l) => l != null).map((l, i) => (
        <div key={i} className={i === 0 ? "text-ink-on-dark-3" : undefined}>
          {l}
        </div>
      ))}
    </div>
  );
}

type TipProps = TooltipContentProps<ValueType, NameType>;
const tooltipBase = { isAnimationActive: false, wrapperStyle: { outline: "none", zIndex: 30 } } as const;

/** `note`: an extra hover line ("Estimated from transactions"). */
export type TrendPoint = { label: string; value: number; note?: string };

export type TrendLineProps = {
  /** Values in integer cents. */
  data: readonly TrendPoint[];
  /** px, or "100%" to fill a sized parent. */
  height?: number | string;
  /** `hero`: white line and 8% white area for the dark hero. */
  tone?: "hero" | "default";
  label?: string;
  className?: string;
};

/** Net-worth style line: 1.25 px line, 8% area, no axes. The line draws in on first view. */
export function TrendLine({ data, height = 130, tone = "default", label = "Trend", className }: TrendLineProps) {
  const reduced = useReducedMotion();
  const first = data[0]?.value ?? 0;
  return (
    <Frame height={height} label={label} className={cn(tone === "hero" ? "text-white" : "text-ink", className)}>
      <AreaChart accessibilityLayer={false} data={[...data]} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <YAxis hide domain={([lo, hi]: readonly number[]) => [lo - (hi - lo) * 0.35, hi + (hi - lo) * 0.08]} />
        <XAxis hide dataKey="label" />
        <Tooltip
          {...tooltipBase}
          cursor={{ stroke: "currentColor", strokeOpacity: 0.3, strokeWidth: 1 }}
          content={({ active, payload, label: l }: TipProps) =>
            active && payload?.length ? (
              <Tip
                lines={[
                  l,
                  formatMoney(Number(payload[0].value)),
                  `${formatMoney(Number(payload[0].value) - first, { signed: true })} since ${data[0]?.label}`,
                  (payload[0].payload as TrendPoint | undefined)?.note,
                ]}
              />
            ) : null
          }
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke="currentColor"
          strokeWidth={1.25}
          fill="currentColor"
          fillOpacity={0.08}
          activeDot={{ r: 3, fill: "currentColor", stroke: "none" }}
          isAnimationActive={!reduced}
          animationDuration={900}
          animationEasing="ease-out"
        />
      </AreaChart>
    </Frame>
  );
}

export type BarsProps = {
  data: readonly { label: string; values: readonly number[] }[];
  /** One name per value; colors follow the gray ramp. */
  series: readonly string[];
  /** One fill per series (a category's label color); a missing one takes the gray ramp. */
  colors?: readonly (string | null | undefined)[];
  /** Treat values as cents. */
  money?: MoneyFormat;
  /** px, or "100%" to fill a sized parent. */
  height?: number | string;
  label?: string;
  className?: string;
};

/** Gray-ramp bars. Each bar rises in on first view, 20 ms after the one before. */
export function Bars({ data, series, colors, money, height = 180, label = "Bar chart", className }: BarsProps) {
  const reduced = useReducedMotion();
  const rows = data.map((d) => Object.fromEntries([["label", d.label], ...d.values.map((v, i) => [`s${i}`, v])]));
  return (
    <Frame height={height} label={label} className={className}>
      <BarChart accessibilityLayer={false} data={rows} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barGap={2} barCategoryGap="24%">
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          tick={{ fill: "var(--ink-3)", fontSize: 12 }}
          tickMargin={8}
          interval={0}
        />
        <YAxis hide />
        <Tooltip
          {...tooltipBase}
          cursor={{ fill: "var(--tint)" }}
          content={({ active, payload, label: l }: TipProps) =>
            active && payload?.length ? (
              <Tip lines={[l, ...payload.map((p, i) => `${series[i]} ${fmt(Number(p.value), money)}`)]} />
            ) : null
          }
        />
        {series.map((name, s) => (
          <RBar
            key={name}
            dataKey={`s${s}`}
            name={name}
            fill={colors?.[s] ?? RAMP[s % RAMP.length]}
            isAnimationActive={false}
            shape={(p: React.ComponentProps<typeof Rectangle> & { index?: number }) => (
              <motion.g
                initial={{ scaleY: reduced ? 1 : 0 }}
                animate={{ scaleY: 1 }}
                transition={{ duration: 0.32, ease: EASE, delay: ((p.index ?? 0) * series.length + s) * 0.02 }}
                style={{ transformBox: "fill-box", originY: 1 }}
              >
                <Rectangle {...p} radius={[4, 4, 0, 0]} />
              </motion.g>
            )}
          />
        ))}
      </BarChart>
    </Frame>
  );
}

export type DonutProps = {
  /** `color`: a category's own label color; without it the slice takes the gray ramp. */
  data: readonly { label: string; value: number; color?: string }[];
  money?: MoneyFormat;
  size?: number;
  label?: string;
  className?: string;
};

/** Gray-ramp donut. Slices sweep in once on first view. */
export function Donut({ data, money, size = 160, label = "Donut chart", className }: DonutProps) {
  const reduced = useReducedMotion();
  const total = data.reduce((a, d) => a + d.value, 0) || 1;
  return (
    <Frame height={size} label={label} className={cn("mx-auto", className)} width={size}>
      <PieChart accessibilityLayer={false} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
        <Tooltip
          {...tooltipBase}
          content={({ active, payload }: TipProps) =>
            active && payload?.length ? (
              <Tip
                lines={[
                  payload[0].name,
                  `${fmt(Number(payload[0].value), money)} · ${Math.round((Number(payload[0].value) / total) * 100)}%`,
                ]}
              />
            ) : null
          }
        />
        <Pie
          data={[...data]}
          dataKey="value"
          nameKey="label"
          rootTabIndex={-1}
          innerRadius="68%"
          outerRadius="100%"
          startAngle={90}
          endAngle={-270}
          stroke="var(--surface)"
          strokeWidth={1.5}
          isAnimationActive={!reduced}
          animationDuration={700}
          animationEasing="ease-out"
        >
          {data.map((d, i) => (
            <Cell key={d.label} fill={d.color ?? RAMP[i % RAMP.length]} />
          ))}
        </Pie>
      </PieChart>
    </Frame>
  );
}

export type SparklineProps = {
  data: readonly number[];
  height?: number;
  label?: string;
  className?: string;
};

/** Tiny ink line, no axes, no dots. */
export function Sparkline({ data, height = 28, label = "Sparkline", className }: SparklineProps) {
  const reduced = useReducedMotion();
  return (
    <Frame height={height} label={label} className={className}>
      <LineChart accessibilityLayer={false} data={data.map((v, i) => ({ i, v }))} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <Line
          type="monotone"
          dataKey="v"
          stroke="var(--ink)"
          strokeWidth={1.25}
          dot={false}
          activeDot={false}
          isAnimationActive={!reduced}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </LineChart>
    </Frame>
  );
}

export type SankeyNode = {
  name: string;
  /** CSS color. Destinations use `var(--sankey-*)`; the income side stays ink and gray (the default). */
  color?: string;
};

export type SankeyProps = {
  nodes: readonly SankeyNode[];
  /** Values in integer cents. */
  links: readonly { source: number; target: number; value: number }[];
  height?: number;
  label?: string;
  className?: string;
};

type LaidNode = { x: number; y: number; width: number; height: number; index: number; payload: SankeyNode & { value: number } };
type LaidLink = {
  sourceX: number;
  targetX: number;
  sourceY: number;
  targetY: number;
  sourceControlX: number;
  targetControlX: number;
  linkWidth: number;
  index: number;
  payload: { source: { name: string; color?: string }; target: { name: string; color?: string }; value: number };
};

/**
 * Cash-flow Sankey. The one chart with color (owner, 2026-11-21): bands take their destination's
 * `--sankey-*` color at `--sankey-band-opacity`; the income side is ink and gray. Fades in once.
 */
export function Sankey({ nodes, links, height = 440, label = "Cash flow", className }: SankeyProps) {
  const reduced = useReducedMotion();
  const sources = new Set(links.map((l) => l.source));
  const terminal = (i: number) => !sources.has(i);
  const incoming = new Set(links.map((l) => l.target));
  const total = links.filter((l) => !incoming.has(l.source)).reduce((a, l) => a + l.value, 0) || 1;
  let gray = 0;
  const colored = nodes.map((n, i) => ({
    ...n,
    color: n.color ?? (incoming.has(i) && sources.has(i) ? "var(--ramp-1)" : RAMP[gray++ % 3]),
  }));
  const share = (v: number) => `${((v / total) * 100).toFixed(1)}%`;

  return (
    <motion.div
      initial={{ opacity: reduced ? 1 : 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true }}
      transition={{ duration: 0.4, ease: EASE }}
    >
      <Frame height={height} label={label} className={className}>
        <RSankey
          accessibilityLayer={false}
          data={{ nodes: colored, links: [...links] }}
          sort={false}
          iterations={0}
          nodeWidth={14}
          nodePadding={8}
          margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
          link={(p: LaidLink) => {
            const ti = colored.findIndex((n) => n.name === p.payload.target.name);
            const stroke = terminal(ti) ? p.payload.target.color : p.payload.source.color;
            return (
              <path
                d={`M${p.sourceX},${p.sourceY} C${p.sourceControlX},${p.sourceY} ${p.targetControlX},${p.targetY} ${p.targetX},${p.targetY}`}
                fill="none"
                stroke={stroke}
                strokeWidth={Math.max(1, p.linkWidth)}
                style={{ strokeOpacity: "var(--sankey-band-opacity)" }}
                className="transition-[stroke-opacity] duration-200 hover:[stroke-opacity:0.5]!"
              />
            );
          }}
          node={(p: LaidNode) => {
            const end = terminal(p.index);
            const showLabel = !end || p.height >= 30;
            const tx = end ? p.x - 10 : p.x + p.width + 10;
            const anchor = end ? "end" : "start";
            return (
              <g>
                <rect x={p.x} y={p.y} width={p.width} height={Math.max(2, p.height)} rx={3} style={{ fill: p.payload.color }} />
                {showLabel && (
                  <text x={tx} y={p.y + p.height / 2} textAnchor={anchor} className="tabular-nums">
                    <tspan x={tx} dy="-0.35em" style={{ fill: "var(--ink-3)", fontSize: 12 }}>
                      {p.payload.name}
                    </tspan>
                    <tspan x={tx} dy="1.25em" style={{ fill: "var(--ink)", fontSize: 13, fontWeight: 600 }}>
                      {formatMoney(p.payload.value, { whole: true })} ({share(p.payload.value)})
                    </tspan>
                  </text>
                )}
              </g>
            );
          }}
        >
          <Tooltip
            {...tooltipBase}
            content={({ active, payload }: TipProps) => {
              const item = payload?.[0];
              if (!active || !item) return null;
              const p = item.payload as Partial<LaidLink["payload"]> & { name?: string; value?: number };
              const v = Number(item.value);
              return p.source && p.target ? (
                <Tip lines={[`${p.source.name} → ${p.target.name}`, `${formatMoney(v)} · ${share(v)}`]} />
              ) : (
                <Tip lines={[p.name ?? "", `${formatMoney(v)} · ${share(v)}`]} />
              );
            }}
          />
        </RSankey>
      </Frame>
    </motion.div>
  );
}
