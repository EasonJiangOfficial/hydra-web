"use client";

import { Check, Minus } from "lucide-react";
import { useState, type ComponentProps } from "react";

import { cn } from "@/lib/utils";

export type CheckboxChangeEvent = { target: { checked: boolean; name?: string }; currentTarget: { checked: boolean; name?: string } };

/**
 * Hydra checkbox: a 16 px box with 4 px corners and a rule-2 border; checked turns the border ink and
 * draws an ink check, indeterminate an ink dash. A button with role="checkbox", so a wrapping `<label>`
 * or `<label htmlFor>` toggles it. Takes the native props (`checked`, `onChange(e)` with
 * `e.target.checked`) and posts "on" with a form when `name` is set and it is checked.
 */
export function Checkbox({
  checked,
  defaultChecked,
  indeterminate = false,
  onChange,
  onCheckedChange,
  name,
  value = "on",
  className,
  disabled,
  onClick,
  ...props
}: Omit<ComponentProps<"button">, "onChange" | "value"> & {
  checked?: boolean;
  defaultChecked?: boolean;
  indeterminate?: boolean;
  onChange?: (e: CheckboxChangeEvent) => void;
  onCheckedChange?: (checked: boolean) => void;
  name?: string;
  value?: string;
}) {
  const [inner, setInner] = useState(!!defaultChecked);
  const on = checked ?? inner;
  return (
    <>
      <button
        type="button"
        role="checkbox"
        aria-checked={indeterminate ? "mixed" : on}
        data-state={indeterminate ? "indeterminate" : on ? "checked" : "unchecked"}
        data-slot="checkbox"
        disabled={disabled}
        {...props}
        onKeyDown={(e) => {
          props.onKeyDown?.(e);
          // Space toggles, as on a native checkbox; Enter on a button would click it too, so it does nothing here.
          if (e.key === "Enter") e.preventDefault();
        }}
        onClick={(e) => {
          onClick?.(e);
          if (e.defaultPrevented) return;
          const next = indeterminate ? true : !on;
          if (checked === undefined) setInner(next);
          const t = { checked: next, name };
          onChange?.({ target: t, currentTarget: t });
          onCheckedChange?.(next);
        }}
        // Children take no clicks: inside a <label>, Safari re-clicks the button when the click lands on the
        // icon, which toggled it twice.
        className={cn(
          "inline-grid size-4 shrink-0 cursor-pointer place-items-center rounded-sm border border-rule-2 bg-surface text-ink outline-none transition-colors duration-200 hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40 data-[state=checked]:border-ink data-[state=indeterminate]:border-ink",
          className,
        )}
      >
        {indeterminate ? (
          <Minus aria-hidden strokeWidth={2.5} className="pointer-events-none size-3" />
        ) : on ? (
          <Check aria-hidden strokeWidth={2.5} className="pointer-events-none size-3 motion-safe:animate-hy-fade" />
        ) : null}
      </button>
      {name && on ? <input type="hidden" name={name} value={value} /> : null}
    </>
  );
}
