"use client";

import { useInView, useReducedMotion } from "motion/react";
import { useMemo, useRef } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import { formatMoney } from "@/components/kit/money";
import { formatDay } from "@/lib/planning/dates";
import { ESTIMATED } from "@/lib/reports/estimated";
import type { NetWorthPoint } from "./types";

type Datum = { label: string; value: number; assets: number; debts: number; estimated: boolean };

/**
 * The hero's trend line: the kit TrendLine look (white 1.25 px line, 8% area, no axes, draws in once)
 * with the hover card DESIGN.md section 7 asks for: date, value, change, assets and debts.
 */
export function NetWorthChart({ points, today }: { points: readonly NetWorthPoint[]; today: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.2 });
  const reduced = useReducedMotion();
  const data = useMemo<Datum[]>(
    () => points.map((p) => ({ label: formatDay(p.day, today), value: p.netCents, assets: p.assetsCents, debts: p.debtsCents, estimated: !!p.estimated })),
    [points, today],
  );
  const first = data[0];
  return (
    <div ref={ref} role="img" aria-label="Net worth trend" data-testid="net-worth-chart" className="relative size-full min-w-0 text-white">
      {seen && (
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 1 }}>
          <AreaChart accessibilityLayer={false} data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <YAxis hide domain={([lo, hi]: readonly number[]) => [lo - (hi - lo) * 0.35, hi + (hi - lo) * 0.08]} />
            <XAxis hide dataKey="label" />
            <Tooltip
              isAnimationActive={false}
              wrapperStyle={{ outline: "none", zIndex: 30 }}
              cursor={{ stroke: "currentColor", strokeOpacity: 0.3, strokeWidth: 1 }}
              content={({ active, payload }: TooltipContentProps<ValueType, NameType>) => {
                const d = active ? (payload?.[0]?.payload as Datum | undefined) : undefined;
                if (!d || !first) return null;
                const lines = [
                  d.label,
                  formatMoney(d.value),
                  `${formatMoney(d.value - first.value, { signed: true })} since ${first.label}`,
                  `Assets ${formatMoney(d.assets, { whole: true })} · Debts ${formatMoney(d.debts, { whole: true })}`,
                  ...(d.estimated ? [ESTIMATED] : []),
                ];
                return (
                  <div
                    data-testid="net-worth-tip"
                    className="animate-in rounded-lg bg-ink px-2.5 py-2 text-tag leading-[1.45] whitespace-nowrap text-white tabular-nums duration-140 fade-in-0 slide-in-from-bottom-1"
                  >
                    {lines.map((l, i) => (
                      <div key={i} className={i === 0 || l === ESTIMATED ? "text-ink-on-dark-3" : undefined}>
                        {l}
                      </div>
                    ))}
                  </div>
                );
              }}
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
        </ResponsiveContainer>
      )}
    </div>
  );
}
