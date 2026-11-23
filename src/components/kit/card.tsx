import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { Children } from "react";
import { cn } from "@/lib/utils";
import { InfoDot } from "./hover-card";

/** `as` prop helper: the element's own props minus `as`. */
export type As<T extends ElementType, P = object> = P & { as?: T } & Omit<ComponentPropsWithoutRef<T>, keyof P | "as">;

type CardOwn = {
  /** `hero`: solid ink, white text, 16 px corners. The one hero per page. */
  tone?: "default" | "hero";
};

/**
 * White, 1 px hairline, 12 px corners, 24 px padding, 12 px gap, column. Inside another Card it turns
 * into a tint block with no border and 8 px corners. `as="button"`, `as="a"` or `as={Link}` adds the hover tint.
 */
export function Card<T extends ElementType = "section">({ as, tone = "default", className, ...props }: As<T, CardOwn>) {
  const Comp: ElementType = as ?? "section";
  const interactive = typeof Comp !== "string" || Comp === "a" || Comp === "button";
  return (
    <Comp
      data-slot="card"
      data-tone={tone === "hero" ? "hero" : undefined}
      className={cn(
        "relative flex min-w-0 flex-col gap-3 rounded-xl border border-rule bg-surface p-6 text-left max-md:p-4",
        tone === "hero"
          ? "rounded-2xl border-obsidian bg-obsidian text-white"
          : "in-data-[slot=card]:rounded-lg in-data-[slot=card]:border-0 in-data-[slot=card]:bg-tint",
        interactive &&
          "transition-colors duration-200 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
        className,
      )}
      {...props}
    />
  );
}

const STRIP_COLS = {
  2: "grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
} as const;

/** Several cells inside one outline, hairlines between them, no gaps (the Dashboard "this month" strip). */
export function Strip({
  cols,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"div"> & { cols?: keyof typeof STRIP_COLS }) {
  const n = (cols ?? Math.min(4, Math.max(2, Children.count(children)))) as keyof typeof STRIP_COLS;
  return (
    <div
      data-slot="strip"
      className={cn("grid gap-px overflow-hidden rounded-xl border border-rule bg-rule", STRIP_COLS[n], className)}
      {...props}
    >
      {children}
    </div>
  );
}

/** 13 px gray label, sentence case. Lighter gray inside the hero. */
export function Label<T extends ElementType = "span">({ as, className, ...props }: As<T>) {
  const Comp: ElementType = as ?? "span";
  return (
    <Comp className={cn("text-label text-ink-3 in-data-[tone=hero]:text-ink-on-dark-3", className)} {...props} />
  );
}

export type StatProps = {
  label: ReactNode;
  /** The figure, usually a `<Money>` or `<MotionNumber>`. */
  children: ReactNode;
  /** Sits on the figure's baseline, e.g. a Pill or a short unit. */
  aside?: ReactNode;
  /** Explanation behind an InfoDot in the top-right corner. */
  info?: ReactNode;
  className?: string;
};

/** Label, 26 px medium tabular figure, optional InfoDot 16 px from the top-right corner. A Strip cell. */
export function Stat({ label, children, aside, info, className }: StatProps) {
  return (
    <div data-slot="stat" className={cn("relative flex min-w-0 flex-col gap-3 bg-surface p-6 max-md:p-4", className)}>
      <Label className={info ? "pr-6" : undefined}>{label}</Label>
      <div className="flex items-baseline gap-2.5">
        <span className="text-figure-s tabular-nums">{children}</span>
        {aside}
      </div>
      {info && <InfoDot className="absolute top-4 right-4 max-md:top-3 max-md:right-3">{info}</InfoDot>}
    </div>
  );
}

const PILL_TONES = {
  default: "text-ink-3 in-data-[tone=hero]:text-ink-on-dark-3",
  strong: "font-semibold text-ink",
  soft: "text-ink-2",
  loss: "text-neg",
} as const;

/** Status and tags: plain 12 px medium text, never a chip. */
export function Pill({
  tone = "default",
  className,
  ...props
}: ComponentPropsWithoutRef<"span"> & { tone?: keyof typeof PILL_TONES }) {
  return (
    <span
      data-slot="pill"
      className={cn("inline-flex items-center text-tag font-medium whitespace-nowrap", PILL_TONES[tone], className)}
      {...props}
    />
  );
}

/** List row: 10 px vertical padding, hairline between rows, none above the first. */
export function ListRow<T extends ElementType = "div">({ as, className, ...props }: As<T>) {
  const Comp: ElementType = as ?? "div";
  const interactive = typeof Comp !== "string" || Comp === "a" || Comp === "button";
  return (
    <Comp
      data-slot="list-row"
      className={cn(
        "flex w-full min-w-0 items-center gap-3 border-t border-rule py-2.5 text-left text-body first:border-t-0",
        "in-data-[tone=hero]:border-white/16",
        interactive && "transition-colors duration-200 hover:bg-tint",
        className,
      )}
      {...props}
    />
  );
}
