"use client";

import { ChevronDown, Search } from "lucide-react";
import {
  Children,
  Fragment,
  isValidElement,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

import {
  FIELD,
  OptionList,
  Picker,
  PickerAnchor,
  PickerContent,
  firstEnabled,
  listKey,
  optionId,
  typeAheadMatch,
  usePhonePicker,
  useTypeAhead,
  type PickerOption,
} from "./picker";

/** What `onChange` gets: the native select's `e.target.value` shape, so call sites keep their handlers. */
export type SelectChangeEvent = {
  target: { value: string; name?: string; selectedOptions: { value: string }[] };
  currentTarget: { value: string; name?: string; selectedOptions: { value: string }[] };
};

type Scalar = string | number;

export type SelectProps = Omit<ComponentProps<"button">, "value" | "defaultValue" | "onChange" | "children"> & {
  value?: Scalar | readonly Scalar[] | null;
  defaultValue?: Scalar | readonly Scalar[] | null;
  onChange?: (e: SelectChangeEvent) => void;
  onValueChange?: (value: string) => void;
  /** `<option>` and `<optgroup>` children, read like a native select (they are never rendered). */
  children?: ReactNode;
  /** Or the options as data, with icons. */
  options?: readonly PickerOption[];
  /** Pick many; stays open while picking. `value` is an array. */
  multiple?: boolean;
  /** A search field above the list. On by default for lists over 12. */
  searchable?: boolean;
  /** Shown when nothing is picked and no option has the value "". */
  placeholder?: string;
  name?: string;
  required?: boolean;
};

const textOf = (node: ReactNode): string => {
  let out = "";
  Children.forEach(node, (c) => {
    if (typeof c === "string" || typeof c === "number") out += String(c);
    else if (isValidElement<{ children?: ReactNode }>(c)) out += textOf(c.props.children);
  });
  return out;
};

/** Reads `<option>` / `<optgroup>` children (through fragments and arrays) into options. */
export function readOptions(children: ReactNode, group?: string, out: PickerOption[] = []): PickerOption[] {
  Children.forEach(children, (node) => {
    if (!isValidElement(node)) return;
    const el = node as ReactElement<{ children?: ReactNode; value?: Scalar; label?: string; disabled?: boolean }>;
    if (el.type === Fragment) readOptions(el.props.children, group, out);
    else if (el.type === "optgroup") readOptions(el.props.children, el.props.label, out);
    else if (el.type === "option") {
      const label = textOf(el.props.children) || el.props.label || "";
      out.push({ value: el.props.value !== undefined ? String(el.props.value) : label, label, disabled: !!el.props.disabled, group });
    }
  });
  return out;
}

/** The options whose label or group holds `query` (case ignored); all of them for an empty query. */
const filterOptions = (options: readonly PickerOption[], query: string) => {
  const q = query.trim().toLowerCase();
  return q ? options.filter((o) => o.label.toLowerCase().includes(q) || o.group?.toLowerCase().includes(q)) : options;
};

const toList = (v: Scalar | readonly Scalar[] | null | undefined): string[] =>
  v === null || v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v as Scalar)];

const TRIGGER = cn(
  FIELD,
  "inline-flex cursor-pointer items-center gap-2 pr-2.5 pl-3 text-left *:pointer-events-none focus:border-ink data-[state=open]:border-ink disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-ink",
);

/**
 * Hydra select: a field in the Input look that opens a list (a bottom sheet on phones). The chosen row has
 * a check. Hover and arrow keys move the highlight; type-ahead, Home, End, PageUp, PageDown, Enter and
 * Escape work as in a native select. Takes the native select's props (`value`, `onChange(e)`, `<option>`
 * children), and posts its value with a form through a hidden input when `name` is set.
 */
export function Select({
  value,
  defaultValue,
  onChange,
  onValueChange,
  children,
  options: optionsProp,
  multiple = false,
  searchable,
  placeholder,
  name,
  required,
  className,
  disabled,
  id,
  onKeyDown,
  ...props
}: SelectProps) {
  const listId = useId();
  const phone = usePhonePicker();
  const options = useMemo(() => optionsProp ?? readOptions(children), [optionsProp, children]);
  const [inner, setInner] = useState<string[]>(() => toList(defaultValue));
  const current = value !== undefined ? toList(value) : inner;
  const selected = new Set(current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const typeAhead = useTypeAhead();
  const withSearch = searchable ?? options.length > 12;

  const shown = useMemo(() => filterOptions(options, query), [options, query]);

  const emit = (next: string[]) => {
    if (value === undefined) setInner(next);
    const v = next[0] ?? "";
    const t = { value: v, name, selectedOptions: next.map((x) => ({ value: x })) };
    onChange?.({ target: t, currentTarget: t });
    onValueChange?.(v);
  };

  const pick = (o: PickerOption | undefined) => {
    if (!o || o.disabled) return;
    if (multiple) {
      emit(selected.has(o.value) ? current.filter((x) => x !== o.value) : [...current, o.value]);
      return;
    }
    setOpen(false);
    if (current[0] !== o.value || current.length !== 1) emit([o.value]);
  };

  const openList = (start?: number) => {
    if (disabled) return;
    const at = options.findIndex((o) => selected.has(o.value));
    setQuery("");
    setActive(start ?? (at >= 0 ? at : firstEnabled(options)));
    setOpen(true);
  };

  const chosen = options.filter((o) => selected.has(o.value));
  const display = chosen.length ? chosen.map((o) => o.label).join(", ") : placeholder ?? "";
  const muted = chosen.every((o) => o.value === "");

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || (e.altKey && e.key === "ArrowDown")) {
      e.preventDefault();
      openList();
    } else if (e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (withSearch) {
        // The first key is the search: the highlight goes to its first match, not to the chosen row's index.
        openList(firstEnabled(filterOptions(options, e.key)));
        setQuery(e.key);
        return;
      }
      // Closed type-ahead picks at once, as a native select does.
      const at = options.findIndex((o) => selected.has(o.value));
      const i = typeAheadMatch(options, typeAhead(e.key), at);
      if (i >= 0 && !multiple) pick(options[i]);
      else if (i >= 0) openList(i);
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLElement>, fromSearch: boolean) => {
    const next = listKey(e.key, shown, active);
    if (next !== null && !(fromSearch && (e.key === "Home" || e.key === "End"))) {
      e.preventDefault();
      setActive(next);
      return;
    }
    if (e.key === "Enter" || (!fromSearch && e.key === " ")) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === "Tab") {
      e.preventDefault();
      setOpen(false);
    } else if (!fromSearch && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const i = typeAheadMatch(shown, typeAhead(e.key), active);
      if (i >= 0) setActive(i);
    }
  };

  return (
    <Picker open={open} onOpenChange={setOpen} phone={phone}>
      <PickerAnchor>
        <button
          ref={trigger}
          type="button"
          role="combobox"
          id={id}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-required={required || undefined}
          data-slot="select-trigger"
          data-state={open ? "open" : "closed"}
          data-value={current.join(",")}
          disabled={disabled}
          {...props}
          onClick={(e) => {
            props.onClick?.(e);
            if (e.defaultPrevented) return;
            if (open) setOpen(false);
            else openList();
          }}
          onKeyDown={onTriggerKey}
          className={cn(TRIGGER, className)}
        >
          {/* Every label sits in one grid cell, so the field is as wide as its longest option, like a native select. */}
          <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)]">
            {options.length <= 60
              ? options.map((o, i) => (
                  // The label sits in a pseudo element, so it is out of the field's text and its accessible value.
                  <span key={i} aria-hidden data-label={o.label} className="invisible col-start-1 row-start-1 h-0 truncate before:content-[attr(data-label)]" />
                ))
              : null}
            <span className={cn("col-start-1 row-start-1 truncate", muted && "text-ink-3")}>{display || " "}</span>
          </span>
          <ChevronDown aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-ink-3" />
        </button>
      </PickerAnchor>
      {name ? (multiple ? current : [current[0] ?? ""]).map((v, i) => <input key={i} type="hidden" name={name} value={v} />) : null}
      <PickerContent
        label={props["aria-label"]}
        fallbackLabel={placeholder ?? "Choose"}
        anchor={trigger}
        focusOnClose={trigger}
        initialFocus={() => (withSearch ? search.current : list.current)}
        className={cn(!phone && "max-h-[min(340px,var(--radix-popover-content-available-height))]")}
      >
        {withSearch ? (
          <div className={cn("mb-1 flex shrink-0 items-center gap-2 border-b border-rule px-2", phone ? "h-11" : "h-[34px]")}>
            <Search aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-ink-3" />
            <input
              ref={search}
              role="searchbox"
              aria-label="Search"
              aria-controls={listId}
              aria-activedescendant={active >= 0 && shown[active] ? optionId(listId, active) : undefined}
              value={query}
              placeholder="Search"
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(firstEnabled(filterOptions(options, e.target.value)));
              }}
              onKeyDown={(e) => onListKey(e, true)}
              className="h-full min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-3"
            />
          </div>
        ) : null}
        <OptionList
          id={listId}
          listRef={list}
          tabIndex={-1}
          aria-label={props["aria-label"] ?? placeholder}
          options={shown}
          selected={selected}
          active={active}
          multiple={multiple}
          onActive={setActive}
          onPick={(i) => pick(shown[i])}
          onKeyDown={(e) => onListKey(e, false)}
        />
        {withSearch && !shown.length ? <p className="px-2 py-2 text-label text-ink-3">No match</p> : null}
      </PickerContent>
    </Picker>
  );
}
