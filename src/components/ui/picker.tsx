"use client";

import { Check, X } from "lucide-react";
import { Dialog as DialogPrimitive, Popover as PopoverPrimitive } from "radix-ui";
import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ComponentProps, type ReactNode, type RefObject, type SyntheticEvent } from "react";

import { cn } from "@/lib/utils";

/**
 * The shared surface for Select, DatePicker and TimePicker. Desktop: a popover under the field, in the
 * dropdown-menu look (8 px corners, rule border, 4 px inset rows). Phones (below 640 px): a bottom sheet
 * with 44 px rows. Both portal out, so they work inside slide-outs and dialogs, and focus goes back to the
 * field on close.
 */

const PHONE = "(max-width: 639px)";
const subscribe = (cb: () => void) => {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
export const usePhonePicker = () =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );

const PhoneContext = createContext(false);
export const useInPhoneSheet = () => useContext(PhoneContext);
/** The open picker's onOpenChange, for PickerContent's own Escape. */
const CloseContext = createContext<RefObject<(open: boolean) => void> | null>(null);

/** The field look every custom control shares with `Input`: 34 px, rule-2 border, 8 px corners, ink border on focus. */
export const FIELD =
  "h-[34px] min-w-0 rounded-lg border border-rule-2 bg-surface text-body text-ink outline-none transition-colors duration-200";

export function Picker({
  open,
  onOpenChange,
  phone,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phone: boolean;
  children: ReactNode;
}) {
  const Root = phone ? DialogPrimitive.Root : PopoverPrimitive.Root;
  const close = useRef(onOpenChange);
  useEffect(() => {
    close.current = onOpenChange;
  });
  return (
    <PhoneContext.Provider value={phone}>
      <CloseContext.Provider value={close}>
        <Root open={open} onOpenChange={onOpenChange}>
          {children}
        </Root>
      </CloseContext.Provider>
    </PhoneContext.Provider>
  );
}

/** Wraps the field: the popover lines up with it. */
export function PickerAnchor({ children }: { children: ReactNode }) {
  const phone = useInPhoneSheet();
  return phone ? children : <PopoverPrimitive.Anchor asChild>{children}</PopoverPrimitive.Anchor>;
}

/** The text of the `<label>` that names the field (its input or button), if any. */
function fieldLabel(anchor: HTMLElement | null): string | undefined {
  const field = anchor?.matches("input, button") ? anchor : anchor?.querySelector("input, button");
  const text = (field as HTMLInputElement | null)?.labels?.[0]?.textContent?.trim();
  return text || undefined;
}

export function PickerContent({
  label: labelProp,
  fallbackLabel,
  anchor,
  focusOnClose,
  initialFocus,
  className,
  children,
}: {
  /** The accessible name and the sheet title on phones. By default the field's own label, then `fallbackLabel`. */
  label?: string;
  fallbackLabel: string;
  /** Clicks and focus on the field do not count as "outside". */
  anchor: RefObject<HTMLElement | null>;
  /** Gets focus back on close, unless the owner moved focus somewhere else. */
  focusOnClose: RefObject<HTMLElement | null>;
  /** Gets focus on open. Null keeps focus where it is (typing in the field). */
  initialFocus?: () => HTMLElement | null | undefined;
  className?: string;
  children: ReactNode;
}) {
  const phone = useInPhoneSheet();
  const content = useRef<HTMLDivElement>(null);
  const label = labelProp ?? fieldLabel(anchor.current) ?? fallbackLabel;
  const onOpenAutoFocus = (e: Event) => {
    e.preventDefault();
    const el = initialFocus?.();
    if (el) el.focus({ preventScroll: true });
    else if (phone) content.current?.focus({ preventScroll: true });
  };
  const onCloseAutoFocus = (e: Event) => {
    e.preventDefault();
    const active = document.activeElement;
    if (!active || active === document.body || content.current?.contains(active)) focusOnClose.current?.focus({ preventScroll: true });
  };
  // The content is portaled, but React events still bubble up the component tree: keep a pick from also
  // clicking the row or card the field sits in (a table row that opens its panel, for one).
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  // Escape closes the picker only, never a slide-out or dialog under it. Each Radix layer hears Escape on the
  // document, and the slide-out's can run first and take itself for the top layer (measured: about 1 run in 2 on
  // a phone). So the open picker takes the key on the window, before any of them, and closes itself.
  const close = useContext(CloseContext);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || content.current?.dataset.state !== "open") return;
      e.stopPropagation();
      e.preventDefault();
      close?.current(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);
  const outside = (e: { target: EventTarget | null; preventDefault: () => void }) => {
    if (e.target instanceof Node && anchor.current?.contains(e.target)) e.preventDefault();
  };

  if (phone) {
    // Inside a slide-out or dialog the page is already dimmed by its scrim: a second one would double it.
    const nested = !!anchor.current?.closest('[role="dialog"], [role="alertdialog"]');
    return (
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="picker-overlay"
          className={cn("fixed inset-0 z-50 duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0", nested ? "bg-transparent" : "bg-obsidian/20")}
        />
        <DialogPrimitive.Content
          ref={content}
          aria-describedby={undefined}
          data-slot="picker-sheet"
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          onClick={stop}
          onKeyDown={stop}
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[82dvh] flex-col rounded-t-xl border-t border-rule bg-surface px-3 pt-2 pb-[max(12px,env(safe-area-inset-bottom))] text-ink outline-none duration-280 data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-7 data-closed:animate-out data-closed:fade-out-0 data-closed:slide-out-to-bottom-7 data-closed:duration-180",
            className,
          )}
        >
          <div className="flex items-center gap-2 pl-2">
            <DialogPrimitive.Title className="flex-1 truncate text-label font-normal text-ink-3">{label}</DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="Close"
              className="inline-grid size-11 place-items-center rounded-lg text-ink-3 transition-colors duration-200 hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
            >
              <X aria-hidden className="size-4" strokeWidth={1.5} />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  }
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={content}
        aria-label={label}
        data-slot="picker-popover"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={onCloseAutoFocus}
        onClick={stop}
        onKeyDown={stop}
        onInteractOutside={outside}
        className={cn(
          "z-50 flex max-h-(--radix-popover-content-available-height) min-w-(--radix-popover-trigger-width) origin-(--radix-popover-content-transform-origin) flex-col rounded-lg border border-rule bg-popover p-1 text-popover-foreground outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

// ---- The option list (Select and TimePicker) ----

export type PickerOption = {
  value: string;
  label: string;
  /** Leading icon, 16 px. */
  icon?: ReactNode;
  disabled?: boolean;
  /** Group heading (from `<optgroup label>`). */
  group?: string;
};

/** Index of the next enabled option from `from` in `dir`, wrapping off; `from` itself when none. */
export function stepEnabled(options: readonly PickerOption[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (!options[i].disabled) return i;
  return from;
}
export const firstEnabled = (options: readonly PickerOption[]) => stepEnabled(options, -1, 1);
export const lastEnabled = (options: readonly PickerOption[]) => stepEnabled(options, options.length, -1);

/**
 * Type-ahead: the next enabled option after `active` whose label starts with `query` (case ignored),
 * wrapping round. A repeated single letter cycles through the matches. -1 when nothing matches.
 */
export function typeAheadMatch(options: readonly PickerOption[], query: string, active: number): number {
  const q = query.toLowerCase();
  const cycle = q.length > 1 && [...q].every((c) => c === q[0]);
  const needle = cycle ? q[0] : q;
  const start = cycle || q.length === 1 ? active + 1 : Math.max(active, 0);
  for (let k = 0; k < options.length; k++) {
    const i = (start + k) % options.length;
    const o = options[i];
    if (!o.disabled && o.label.toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

/** A typed-letter buffer that clears after 500 ms, like a native select. */
export function useTypeAhead() {
  const buf = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (key: string) => {
    clearTimeout(timer.current);
    buf.current += key;
    timer.current = setTimeout(() => (buf.current = ""), 500);
    return buf.current;
  };
}

/**
 * Arrow keys, Home and End, PageUp and PageDown over a list. Returns the new active index, or null when
 * the key is not a list key.
 */
export function listKey(key: string, options: readonly PickerOption[], active: number): number | null {
  switch (key) {
    case "ArrowDown":
      return active < 0 ? firstEnabled(options) : stepEnabled(options, active, 1);
    case "ArrowUp":
      return active < 0 ? lastEnabled(options) : stepEnabled(options, active, -1);
    case "Home":
      return firstEnabled(options);
    case "End":
      return lastEnabled(options);
    case "PageDown": {
      let i = active;
      for (let n = 0; n < 10; n++) i = stepEnabled(options, i, 1);
      return i;
    }
    case "PageUp": {
      let i = active;
      for (let n = 0; n < 10; n++) i = stepEnabled(options, i, -1);
      return i;
    }
  }
  return null;
}

export const optionId = (listId: string, i: number) => `${listId}-o${i}`;

/** The rows. Keyboard focus stays on the list (or the search field); `active` is shown with aria-activedescendant. */
export function OptionList({
  id,
  options,
  selected,
  active,
  onActive,
  onPick,
  multiple,
  className,
  listRef,
  ...listProps
}: Omit<ComponentProps<"div">, "id" | "onClick"> & {
  listRef?: RefObject<HTMLDivElement | null>;
  id: string;
  options: readonly PickerOption[];
  selected: ReadonlySet<string>;
  active: number;
  onActive: (i: number) => void;
  onPick: (i: number) => void;
  multiple?: boolean;
}) {
  const phone = useInPhoneSheet();
  const own = useRef<HTMLDivElement>(null);
  const list = listRef ?? own;
  const first = useRef(true);
  useEffect(() => {
    if (active < 0) return;
    // On open the popover is placed a frame later; wait for it, then center the chosen row once.
    const block: ScrollLogicalPosition = first.current ? "center" : "nearest";
    first.current = false;
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`#${CSS.escape(optionId(id, active))}`)?.scrollIntoView?.({ block })),
    );
    return () => cancelAnimationFrame(frame);
  }, [active, id, list]);

  const rows: ReactNode[] = [];
  options.forEach((o, i) => {
    if (o.group && o.group !== options[i - 1]?.group) {
      rows.push(
        <div key={`g${i}`} role="presentation" className={cn("px-2 pt-2 pb-1 text-tag text-ink-3", phone && "px-3")}>
          {o.group}
        </div>,
      );
    }
    const isSelected = selected.has(o.value);
    rows.push(
      <div
        key={`o${i}`}
        id={optionId(id, i)}
        role="option"
        data-value={o.value}
        aria-selected={isSelected}
        aria-disabled={o.disabled || undefined}
        data-active={i === active || undefined}
        onPointerMove={() => !o.disabled && i !== active && onActive(i)}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => !o.disabled && onPick(i)}
        className={cn(
          "relative flex shrink-0 cursor-default items-center gap-2 rounded-md pr-8 pl-2 text-body select-none transition-colors duration-100 data-active:bg-tint active:bg-hover aria-disabled:cursor-not-allowed aria-disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0",
          o.group && "pl-4",
          phone ? "min-h-11 text-tab" : "min-h-8 py-1",
        )}
      >
        {o.icon ? <span aria-hidden className="inline-flex text-ink-2">{o.icon}</span> : null}
        <span className="min-w-0 flex-1 truncate">{o.label}</span>
        {isSelected ? (
          <Check aria-hidden strokeWidth={1.75} className="absolute right-2 text-ink" />
        ) : null}
      </div>,
    );
  });
  return (
    <div
      ref={list}
      id={id}
      role="listbox"
      aria-multiselectable={multiple || undefined}
      aria-activedescendant={active >= 0 ? optionId(id, active) : undefined}
      {...listProps}
      className={cn("flex min-h-0 flex-col overflow-y-auto overscroll-contain outline-none", className)}
    >
      {rows}
    </div>
  );
}
