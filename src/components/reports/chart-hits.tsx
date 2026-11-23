"use client";

import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Hover cards and clicks for the kit's charts. The kit draws the marks but not their row ids or counts,
 * so this finds the mark under the pointer by its recharts class and its position among its siblings,
 * then shows the section 7 card (from and to, amount, share, count) and opens its category on click.
 * The kit's own tooltip is hidden so only one card shows. A mouse gets the card; a touch tap just clicks.
 */

export type Hit = { lines: string[]; open?: () => void };
/** One kind of mark: its CSS selector and what the n-th one of them means (null: a mark with no card). */
export type HitTarget = { selector: string; at: (index: number) => Hit | null };

type Shown = { x: number; y: number; flip: boolean; hit: Hit };

export function ChartHits({ targets, className, children }: { targets: readonly HitTarget[]; className?: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Shown | null>(null);

  const find = (el: EventTarget): Hit | null => {
    if (!(el instanceof Element) || !root.current) return null;
    for (const t of targets) {
      const mark = el.closest(t.selector);
      if (!mark) continue;
      const index = [...root.current.querySelectorAll(t.selector)].indexOf(mark);
      return index < 0 ? null : t.at(index);
    }
    return null;
  };

  return (
    <div
      ref={root}
      data-slot="chart-hits"
      className={cn("relative [&_.recharts-tooltip-wrapper]:hidden!", shown?.hit.open && "[&_svg]:cursor-pointer", className)}
      onPointerMove={(e) => {
        if (e.pointerType !== "mouse") return;
        const hit = find(e.target);
        const box = root.current!.getBoundingClientRect();
        setShown(hit && { hit, x: e.clientX - box.left, y: e.clientY - box.top, flip: e.clientX - box.left > box.width * 0.6 });
      }}
      onPointerLeave={() => setShown(null)}
      onClick={(e) => find(e.target)?.open?.()}
    >
      {children}
      {shown && (
        <div
          role="presentation"
          className="pointer-events-none absolute z-30 rounded-lg bg-ink px-2.5 py-2 text-tag leading-[1.45] whitespace-nowrap text-white tabular-nums animate-in fade-in-0 duration-140"
          style={{ left: shown.x, top: shown.y, transform: `translate(${shown.flip ? "calc(-100% - 12px)" : "12px"}, -110%)` }}
        >
          {shown.hit.lines.map((l, i) => (
            <div key={i} className={i === 0 ? "text-ink-on-dark-3" : undefined}>
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
