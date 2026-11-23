import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Ported from UGM `src/components/ui/skeleton.tsx`. Tint block, motion-safe pulse only, no spinner. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("rounded-lg bg-tint motion-safe:animate-pulse", className)}
      {...props}
    />
  );
}

/* Presets for route `loading.tsx` files. Each is sized like the real card it stands for. */

type Box = { className?: string };

/** A Stat cell: label, 26 px figure. */
export function SkeletonStat({ className }: Box) {
  return (
    <div aria-hidden="true" className={cn("flex flex-col gap-3 bg-surface p-6 max-md:p-4", className)}>
      <Skeleton className="h-[17px] w-28 rounded-sm" />
      <Skeleton className="h-[26px] w-24 rounded-sm" />
    </div>
  );
}

/** A Strip of Stat cells. */
export function SkeletonStrip({ cells = 4, className }: Box & { cells?: 2 | 3 | 4 }) {
  const cols = { 2: "grid-cols-2", 3: "grid-cols-1 sm:grid-cols-3", 4: "grid-cols-2 lg:grid-cols-4" }[cells];
  return (
    <div aria-hidden="true" className={cn("grid gap-px overflow-hidden rounded-xl border border-rule bg-rule", cols, className)}>
      {Array.from({ length: cells }, (_, i) => (
        <SkeletonStat key={i} />
      ))}
    </div>
  );
}

/** List rows: 10 px padding, hairlines, 19 px text line. */
export function SkeletonRows({ n = 4, className }: Box & { n?: number }) {
  return (
    <div aria-hidden="true" className={className}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-t border-rule py-2.5 first:border-t-0">
          <Skeleton className="h-[19px] flex-1 rounded-sm" style={{ maxWidth: `${70 - ((i * 13) % 30)}%` }} />
          <Skeleton className="ml-auto h-[19px] w-16 rounded-sm" />
        </div>
      ))}
    </div>
  );
}

/** A standard card: label, figure, rows. */
export function SkeletonCard({ rows = 3, className }: Box & { rows?: number }) {
  return (
    <div aria-hidden="true" className={cn("flex flex-col gap-1.5 rounded-xl border border-rule p-6 max-md:p-4", className)}>
      <Skeleton className="h-[17px] w-24 rounded-sm" />
      <Skeleton className="mb-1.5 h-[26px] w-28 rounded-sm" />
      <SkeletonRows n={rows} />
    </div>
  );
}

/** A chart block inside a card. */
export function SkeletonChart({ height = 180, className }: Box & { height?: number }) {
  return (
    <div aria-hidden="true" className={cn("flex flex-col gap-3 rounded-xl border border-rule p-6 max-md:p-4", className)}>
      <Skeleton className="h-[17px] w-24 rounded-sm" />
      <Skeleton className="w-full" style={{ height }} />
    </div>
  );
}

/** The dark hero's footprint, in tint: 16 px corners, label, 76 px figure, change, trend. */
export function SkeletonHero({ className }: Box) {
  return (
    <div aria-hidden="true" className={cn("flex min-h-[300px] flex-col gap-3 overflow-hidden rounded-2xl bg-tint px-8 pt-8", className)}>
      <Skeleton className="h-[17px] w-20 rounded-sm bg-hover" />
      <Skeleton className="h-[72px] w-72 max-w-full rounded-sm bg-hover max-md:h-[50px]" />
      <Skeleton className="h-[19px] w-40 rounded-sm bg-hover" />
    </div>
  );
}

/** A slide-out's body while its record loads: the 40 px title field, then field rows (46 px, label 96 px). */
export function SkeletonPanel({ rows = 5, className }: Box & { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className={cn("flex flex-col gap-4", className)}>
      <Skeleton className="h-10 w-3/4 rounded-lg" />
      <div>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex min-h-[46px] items-center gap-3 border-t border-rule py-2 first:border-t-0">
            <Skeleton className="h-[17px] w-24 shrink-0 rounded-sm" />
            <Skeleton className="h-[19px] rounded-sm" style={{ width: `${64 - ((i * 17) % 34)}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Cross-fades content in over 150 ms when it replaces a skeleton. */
export function FadeIn({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("animate-in fade-in-0 duration-150", className)} {...props} />;
}
