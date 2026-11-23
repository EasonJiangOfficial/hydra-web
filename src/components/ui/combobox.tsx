"use client";

import { useId, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";

import { Input } from "./input";
import { OptionList, Picker, PickerAnchor, PickerContent, listKey, optionId, type PickerOption } from "./picker";

/** Sets an input's value the way typing does, so React's onChange runs for controlled and uncontrolled fields. */
function typeInto(el: HTMLInputElement, text: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Free text with suggestions: an `Input` whose suggestions open in the Hydra list under it, in place of
 * `<input list>` and `<datalist>` (the browser's own dropdown). Typing filters; ArrowDown and ArrowUp move
 * the highlight; Enter or a click puts the highlighted suggestion in the field; Escape closes. Takes every
 * Input prop, and the call site's onChange, onKeyDown and onBlur run as before.
 */
export function Combobox({
  suggestions,
  value,
  defaultValue,
  onChange,
  onKeyDown,
  onClick,
  className,
  ...props
}: Omit<ComponentProps<"input">, "list"> & { suggestions: readonly string[] }) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(String(value ?? defaultValue ?? ""));
  const shownText = value !== undefined ? String(value) : text;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const options: PickerOption[] = useMemo(() => {
    const q = shownText.trim().toLowerCase();
    const seen = new Set<string>();
    return suggestions
      .filter((s) => s && !seen.has(s) && seen.add(s) && s.toLowerCase().includes(q) && s.toLowerCase() !== q)
      .map((s) => ({ value: s, label: s }));
  }, [suggestions, shownText]);
  const showing = open && options.length > 0;

  const pick = (i: number) => {
    const o = options[i];
    if (!o || !input.current) return;
    typeInto(input.current, o.value);
    setOpen(false);
    setActive(-1);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!showing) {
        setOpen(true);
        setActive(-1);
        return;
      }
      setActive(listKey(e.key, options, active) ?? active);
      return;
    }
    if (showing && e.key === "Enter" && active >= 0) {
      e.preventDefault();
      pick(active);
      // Then the call site's own Enter (most blur to save) sees the picked text.
    } else if (showing && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }
    onKeyDown?.(e);
  };

  return (
    <Picker open={showing} onOpenChange={setOpen} phone={false}>
      <PickerAnchor>
        <Input
          ref={input}
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={showing}
          aria-controls={showing ? listId : undefined}
          aria-activedescendant={showing && active >= 0 ? optionId(listId, active) : undefined}
          {...props}
          value={value}
          defaultValue={defaultValue}
          onChange={(e) => {
            setText(e.target.value);
            setActive(-1);
            setOpen(document.activeElement === e.target);
            onChange?.(e);
          }}
          onClick={(e) => {
            onClick?.(e);
            setOpen(true);
          }}
          onKeyDown={onKey}
          className={className}
        />
      </PickerAnchor>
      <PickerContent
        label={props["aria-label"]}
        fallbackLabel="Suggestions"
        anchor={input}
        focusOnClose={input}
        initialFocus={() => null}
        className="max-h-[min(240px,var(--radix-popover-content-available-height))]"
      >
        <OptionList
          id={listId}
          aria-label={props["aria-label"] ?? "Suggestions"}
          options={options}
          selected={new Set()}
          active={active}
          onActive={setActive}
          onPick={pick}
        />
      </PickerContent>
    </Picker>
  );
}
