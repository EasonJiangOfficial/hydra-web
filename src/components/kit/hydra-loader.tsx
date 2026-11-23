"use client";

import { useEffect, useRef, type ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { mountHydraLoader } from "@/lib/motion/mount-hydra-loader";

export type HydraLoaderProps = Omit<ComponentProps<"span">, "children" | "role"> & {
  /** Square size in px; the mark is about a third of it. Default 64. */
  size?: number;
  tone?: "ink" | "white";
  label?: string;
  /** Freeze on one loop time in seconds (fixtures and screenshots only). */
  at?: number;
};

/** The loading logo: the three rings unroll into snakes and slither away. Still mark under reduced motion. */
export function HydraLoader({ size = 64, tone = "ink", label = "Loading", at, className, style, ...rest }: HydraLoaderProps) {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const loader = mountHydraLoader(host.current, { size, tone, at });
    return () => loader.destroy();
  }, [size, tone, at]);

  return (
    <span
      role="status"
      className={cn("relative inline-block flex-none", className)}
      style={{ ...style, width: size, height: size }}
      {...rest}
    >
      <span ref={host} aria-hidden="true" className="block size-full" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
