"use client";

import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { formatMoney, type MoneyFormat } from "./money";
import { EASE } from "./seg";

const plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export type MotionNumberProps = {
  value: number;
  /** Treat `value` as integer cents and format as money. Without it: a grouped integer. */
  money?: MoneyFormat;
  className?: string;
};

/** Tweens to each new value with tabular digits. Instant under reduced motion. */
export function MotionNumber({ value, money, className }: MotionNumberProps) {
  const reduced = useReducedMotion();
  const mv = useMotionValue(value);
  const { signed, compact, whole } = money ?? {};
  const text = useTransform(mv, (v) =>
    money ? formatMoney(Math.round(v), { signed, compact, whole }) : plain.format(Math.round(v)),
  );
  useEffect(() => {
    if (reduced) {
      mv.set(value);
      return;
    }
    const controls = animate(mv, value, { duration: 0.6, ease: EASE });
    return () => controls.stop();
  }, [value, reduced, mv]);
  return <motion.span className={cn("tabular-nums", className)}>{text}</motion.span>;
}

export type BarProps = {
  /** 0 to 1. */
  value: number;
  className?: string;
  "aria-label"?: string;
};

/** 4 px progress bar, 2 px corners, rule track, ink fill. The fill grows in once, the first time it is seen. */
export function Bar({ value, className, ...aria }: BarProps) {
  const reduced = useReducedMotion();
  const v = Math.min(1, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      aria-label={aria["aria-label"]}
      className={cn("h-1 overflow-hidden rounded-[2px] bg-rule", className)}
    >
      <motion.div
        className="h-full origin-left bg-ink"
        initial={{ scaleX: reduced ? v : 0 }}
        whileInView={{ scaleX: v }}
        viewport={{ once: true }}
        transition={{ duration: 0.6, ease: EASE }}
      />
    </div>
  );
}
