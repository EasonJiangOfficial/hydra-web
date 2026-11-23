"use client";

import { MotionConfig, motion } from "motion/react";
import { RadioGroup } from "radix-ui";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** CSS `ease`, 200 ms: the state-change motion everywhere. */
export const EASE = [0.25, 0.1, 0.25, 1] as const;
export const STATE_TRANSITION = { type: "tween", duration: 0.2, ease: EASE } as const;

export type SegItem = { value: string; label: ReactNode };

export type SegProps = {
  items: readonly SegItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** `dark` for inside the hero: white/12% track, white thumb. */
  tone?: "default" | "dark";
  /** `touch`: 32 px items for phone headers; default 28 px. */
  size?: "default" | "touch";
  "aria-label": string;
  className?: string;
};

/**
 * Segmented control. Tint track, outlined white thumb that slides to the picked item.
 * A radio group: arrow keys move and pick, Tab enters at the picked item.
 */
export function Seg({ items, value, defaultValue, onValueChange, tone = "default", size = "default", className, ...aria }: SegProps) {
  const [inner, setInner] = useState(defaultValue ?? items[0]?.value);
  const current = value ?? inner;
  const id = useId();
  const dark = tone === "dark";
  const pick = (v: string) => {
    setInner(v);
    onValueChange?.(v);
  };
  return (
    <MotionConfig reducedMotion="user" transition={STATE_TRANSITION}>
      <RadioGroup.Root
        value={current}
        onValueChange={pick}
        orientation="horizontal"
        loop
        aria-label={aria["aria-label"]}
        data-slot="seg"
        className={cn("inline-flex shrink-0 rounded-lg p-0.5", dark ? "bg-white/12" : "bg-tint", className)}
      >
        {items.map((item) => {
          const on = item.value === current;
          return (
            <RadioGroup.Item
              key={item.value}
              value={item.value}
              // Radix checks on arrow focus only while the key is still down; a fast tap can miss it.
              onFocus={(e) => {
                if (!on && e.currentTarget.matches(":focus-visible")) pick(item.value);
              }}
              className={cn(
                "relative rounded-md px-3 text-label whitespace-nowrap outline-none transition-colors duration-200",
                size === "touch" ? "h-8" : "h-7",
                "focus-visible:outline-2 focus-visible:outline-offset-1",
                dark ? "focus-visible:outline-white" : "focus-visible:outline-ink",
                on ? cn("font-medium", "text-ink") : dark ? "text-ink-on-dark-3 hover:text-white" : "text-ink-3 hover:text-ink",
              )}
            >
              {on && (
                <motion.span
                  layoutId={`seg-${id}`}
                  aria-hidden
                  className={cn(
                    "absolute inset-0 rounded-md border",
                    dark ? "border-white bg-white" : "border-rule-2 bg-surface",
                  )}
                />
              )}
              {/* An invisible medium-weight copy reserves width, so the control never shifts when the weight changes. */}
              <span className="relative grid">
                <span className="col-start-1 row-start-1">{item.label}</span>
                <span aria-hidden className="invisible col-start-1 row-start-1 font-medium">
                  {item.label}
                </span>
              </span>
            </RadioGroup.Item>
          );
        })}
      </RadioGroup.Root>
    </MotionConfig>
  );
}
