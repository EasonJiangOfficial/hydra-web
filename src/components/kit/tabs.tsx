"use client";

import { MotionConfig, motion } from "motion/react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { createContext, use, useId, useState, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";
import { STATE_TRANSITION } from "./seg";

const TabsCtx = createContext<{ value?: string; id: string }>({ id: "" });

type RootProps = Omit<ComponentPropsWithoutRef<typeof TabsPrimitive.Root>, "orientation">;

/** Radix Tabs with Hydra's look: 28 px gap, bottom hairline, 15 px, a 1.5 px ink underline that slides. */
export function Tabs({ value, defaultValue, onValueChange, className, ...props }: RootProps) {
  const [inner, setInner] = useState(defaultValue);
  const current = value ?? inner;
  const id = useId();
  return (
    <TabsCtx value={{ value: current, id }}>
      <MotionConfig reducedMotion="user" transition={STATE_TRANSITION}>
        <TabsPrimitive.Root
          value={current}
          onValueChange={(v) => {
            setInner(v);
            onValueChange?.(v);
          }}
          className={cn("flex flex-col gap-5", className)}
          {...props}
        />
      </MotionConfig>
    </TabsCtx>
  );
}

export function TabsList({ className, ...props }: ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn("flex gap-7 overflow-x-auto border-b border-rule [scrollbar-width:none]", className)}
      {...props}
    />
  );
}

export function TabsTrigger({ value, className, children, ...props }: ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  const ctx = use(TabsCtx);
  const on = ctx.value === value;
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cn(
        "relative shrink-0 pb-3 text-tab whitespace-nowrap text-ink-3 outline-none transition-colors duration-200 hover:text-ink",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink data-[state=active]:font-medium data-[state=active]:text-ink",
        className,
      )}
      {...props}
    >
      {children}
      {on && (
        <motion.span
          layoutId={`tab-${ctx.id}`}
          aria-hidden
          className="absolute inset-x-0 -bottom-px h-[1.5px] bg-ink"
        />
      )}
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({ className, ...props }: ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("outline-none", className)} {...props} />;
}
