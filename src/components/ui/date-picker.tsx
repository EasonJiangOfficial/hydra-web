"use client";

import { CalendarDays, Clock } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent, type RefObject } from "react";

import {
  formatDay,
  formatTime,
  inRange,
  isHhmm,
  isIsoDay,
  nearestStep,
  parseTypedDay,
  parseTypedTime,
  splitDateTime,
  timeSteps,
  todayDay,
} from "@/lib/date-input";
import { cn } from "@/lib/utils";

import { Calendar } from "./calendar";
import { FIELD, OptionList, Picker, PickerAnchor, PickerContent, listKey, optionId, usePhonePicker, type PickerOption } from "./picker";

/** What `onChange` gets: the native input's `e.target.value` shape (`yyyy-mm-dd`, `HH:mm` or `yyyy-mm-ddTHH:mm`). */
export type ValueChangeEvent = { target: { value: string; name?: string }; currentTarget: { value: string; name?: string } };

type FieldProps = Omit<ComponentProps<"input">, "value" | "defaultValue" | "onChange" | "type" | "min" | "max"> & {
  value?: string | null;
  defaultValue?: string | null;
  onChange?: (e: ValueChangeEvent) => void;
  onValueChange?: (value: string) => void;
};

const WRAP = cn(FIELD, "flex w-full items-center focus-within:border-ink has-disabled:cursor-not-allowed has-disabled:opacity-40 has-aria-invalid:border-ink");
const TEXT = "h-full min-w-0 flex-1 bg-transparent pl-3 text-body text-ink tabular-nums outline-none placeholder:text-ink-3 disabled:cursor-not-allowed";
const ICON =
  "mr-1 inline-grid size-7 shrink-0 place-items-center rounded-md text-ink-3 outline-none transition-colors duration-200 hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-ink disabled:pointer-events-none";

function emitter(name: string | undefined, onChange?: (e: ValueChangeEvent) => void, onValueChange?: (v: string) => void) {
  return (value: string) => {
    const t = { value, name };
    onChange?.({ target: t, currentTarget: t });
    onValueChange?.(value);
  };
}

/**
 * True for a key typed or deleted, false for a paste, a drop or an autofill. A complete value commits at
 * once only when it arrives whole; mid-typing it may still grow ("01:30" + "pm", a day + "T09:00").
 */
const typing = (e: Event) => /^(insertText|insertCompositionText|insertLineBreak|delete)/.test((e as InputEvent).inputType ?? "");

const STRICT_DAY = /^\d{4}-\d{2}-\d{2}$/;
const STRICT_DAY_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;

export type DatePickerProps = FieldProps & {
  min?: string;
  max?: string;
  /** "Today" and day math use this zone (settings.time_zone). */
  timeZone?: string;
  /** This field ends a range that starts here: its calendar shades the days between. */
  rangeStart?: string | null;
  /** This field starts a range that ends here. */
  rangeEnd?: string | null;
  /** Shows Clear in the calendar and lets an emptied field clear the value. Default true. */
  clearable?: boolean;
  /** Internal (DateTimePicker): a typed `yyyy-mm-ddTHH:mm` goes here whole instead of to onChange. */
  onTypedTime?: (day: string, hhmm: string) => void;
};

/**
 * Hydra date field: shows "Nov 21, 2026" and takes typing ("nov 21", "11/21/2026", "2026-11-21",
 * "tomorrow"; Enter or leaving the field commits). Click, Alt+ArrowDown or ArrowDown opens the month
 * calendar (a bottom sheet on phones). The value is a plain `yyyy-mm-dd` day in the owner's zone, never
 * moved by UTC. Drop-in for `<input type="date">`: same `value` and `onChange(e)`, and a hidden input
 * carries `name` in a form.
 */
export function DatePicker({
  value,
  defaultValue,
  onChange,
  onValueChange,
  name,
  id,
  min,
  max,
  disabled,
  required,
  className,
  placeholder = "Date",
  timeZone,
  rangeStart,
  rangeEnd,
  clearable = true,
  onTypedTime,
  onKeyDown,
  onBlur,
  ...props
}: DatePickerProps) {
  const phone = usePhonePicker();
  const calId = useId();
  const [inner, setInner] = useState(defaultValue ?? "");
  const current = value !== undefined && value !== null ? value : value === null ? "" : inner;
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [focusGrid, setFocusGrid] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cal = useRef<HTMLDivElement>(null);
  const send = emitter(name, onChange, onValueChange);
  // Read the clock only on use (typing, or the open calendar), never while rendering the closed field.
  const today = () => todayDay(timeZone);

  const commit = (iso: string) => {
    setDraft(null);
    if (iso === current) return;
    if (iso === "" && !clearable) return;
    if (iso && !inRange(iso, min, max)) return;
    if (value === undefined) setInner(iso);
    send(iso);
  };

  const commitTyped = (text: string) => {
    const t = text.trim();
    const both = STRICT_DAY_TIME.exec(t);
    if (both && isIsoDay(both[1])) {
      if (onTypedTime && isHhmm(both[2])) {
        setDraft(null);
        onTypedTime(both[1], both[2]);
      } else commit(both[1]);
      return;
    }
    commit(t === "" ? "" : (parseTypedDay(t, today()) ?? current));
  };

  const show = (grid: boolean) => {
    if (disabled) return;
    setFocusGrid(grid || phone);
    setOpen(true);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === "Enter") {
      // With the calendar closed, Enter commits what was typed and still submits the form.
      if (open) e.preventDefault();
      if (draft !== null) commitTyped(draft);
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (draft !== null) commitTyped(draft);
      if (open) cal.current?.querySelector<HTMLElement>('[data-day][tabindex="0"]')?.focus();
      else show(true);
    }
  };

  return (
    <Picker open={open} onOpenChange={setOpen} phone={phone}>
      <PickerAnchor>
        <div ref={wrap} data-slot="date-picker" data-value={current} className={cn(WRAP, className)}>
          <input
            ref={input}
            id={id}
            type="text"
            role="combobox"
            autoComplete="off"
            aria-autocomplete="none"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? calId : undefined}
            aria-required={required || undefined}
            disabled={disabled}
            // Phones open the sheet on tap; no on-screen keyboard, but a hardware keyboard or paste still types.
            inputMode={phone ? "none" : undefined}
            placeholder={placeholder}
            {...props}
            value={draft ?? formatDay(current)}
            onChange={(e) => {
              const text = e.target.value;
              setDraft(text);
              // A pasted ISO day or day-and-time commits at once, so paste and autofill land without a blur.
              if (!typing(e.nativeEvent) && (STRICT_DAY.test(text.trim()) || STRICT_DAY_TIME.test(text.trim()))) commitTyped(text);
            }}
            onClick={() => (phone || !open) && show(false)}
            onKeyDown={onKey}
            onBlur={(e) => {
              onBlur?.(e);
              if (draft !== null) commitTyped(draft);
            }}
            className={TEXT}
          />
          <button type="button" tabIndex={-1} aria-hidden data-slot="date-picker-icon" disabled={disabled} onClick={() => (open ? setOpen(false) : show(true))} className={ICON}>
            <CalendarDays aria-hidden strokeWidth={1.5} className="pointer-events-none size-4" />
          </button>
        </div>
      </PickerAnchor>
      {name ? <input type="hidden" name={name} value={current} /> : null}
      <PickerContent
        label={props["aria-label"]}
        fallbackLabel={placeholder}
        anchor={wrap}
        focusOnClose={input}
        initialFocus={() => (focusGrid ? cal.current?.querySelector<HTMLElement>('[data-day][tabindex="0"]') : null)}
        className={cn("overflow-y-auto", !phone && "w-auto min-w-0 p-1")}
      >
        <div ref={cal} id={calId} className={cn(phone && "self-center")}>
          <Calendar
            value={isIsoDay(current) ? current : ""}
            timeZone={timeZone}
            min={min}
            max={max}
            rangeStart={rangeStart ?? undefined}
            rangeEnd={rangeEnd ?? undefined}
            clearable={clearable}
            large={phone}
            onPick={(day) => {
              commit(day);
              setOpen(false);
            }}
          />
        </div>
      </PickerContent>
    </Picker>
  );
}

export type TimePickerProps = FieldProps & {
  /** Minutes between list rows. Default 5. */
  step?: number;
  clearable?: boolean;
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const HOURS: PickerOption[] = Array.from({ length: 24 }, (_, h) => ({ value: pad2(h), label: `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}` }));

/**
 * Hydra time field: shows "9:30 PM", takes typing ("9:30pm", "930", "21:30", "noon"), and opens a list in
 * 5-minute steps. On phones the sheet has an hour column and a minute column, and Clear when clearable.
 * Drop-in for `<input type="time">`: the value is `HH:mm` (24 h).
 */
export function TimePicker({
  value,
  defaultValue,
  onChange,
  onValueChange,
  name,
  id,
  disabled,
  required,
  className,
  placeholder = "Time",
  step = 5,
  clearable = true,
  onKeyDown,
  onBlur,
  ...props
}: TimePickerProps) {
  const phone = usePhonePicker();
  const listId = useId();
  const [inner, setInner] = useState(defaultValue ?? "");
  const current = value !== undefined && value !== null ? value : value === null ? "" : inner;
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // The highlight starts on the step nearest the value; Enter picks it only once the owner has moved it,
  // so opening a 9:07 field and pressing Enter keeps 9:07.
  const moved = useRef(false);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const send = emitter(name, onChange, onValueChange);
  const options: PickerOption[] = useMemo(() => timeSteps(step).map((t) => ({ value: t, label: formatTime(t) })), [step]);
  const selected = useMemo(() => new Set(isHhmm(current) ? [current] : []), [current]);
  const indexOf = (hhmm: string) => options.findIndex((o) => o.value === nearestStep(hhmm, step));
  const moveTo = (i: number) => {
    moved.current = true;
    setActive(i);
  };

  const commit = (hhmm: string) => {
    setDraft(null);
    if (hhmm === current || (hhmm === "" && !clearable)) return;
    if (value === undefined) setInner(hhmm);
    send(hhmm);
  };
  const commitTyped = (text: string) => commit(text.trim() === "" ? "" : (parseTypedTime(text) ?? current));

  const show = () => {
    if (disabled) return;
    moved.current = false;
    setActive(indexOf(isHhmm(current) ? current : "09:00"));
    setOpen(true);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    const next = open ? listKey(e.key, options, active) : null;
    if (next !== null && e.key !== "Home" && e.key !== "End") {
      e.preventDefault();
      setDraft(null);
      moveTo(next);
    } else if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      show();
    } else if (e.key === "Enter") {
      // With the list closed, Enter commits what was typed and still submits the form, as a native field does.
      if (open) e.preventDefault();
      if (draft !== null) commitTyped(draft);
      else if (open && moved.current && options[active]) commit(options[active].value);
      setOpen(false);
    }
  };

  return (
    <Picker open={open} onOpenChange={setOpen} phone={phone}>
      <PickerAnchor>
        <div ref={wrap} data-slot="time-picker" data-value={current} className={cn(WRAP, className)}>
          <input
            ref={input}
            id={id}
            type="text"
            role="combobox"
            autoComplete="off"
            aria-autocomplete="none"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open && active >= 0 && !phone ? optionId(listId, active) : undefined}
            aria-required={required || undefined}
            disabled={disabled}
            // Phones open the sheet on tap; no on-screen keyboard, but a hardware keyboard or paste still types.
            inputMode={phone ? "none" : undefined}
            placeholder={placeholder}
            {...props}
            value={draft ?? formatTime(current)}
            onChange={(e) => {
              const text = e.target.value;
              setDraft(text);
              const t = parseTypedTime(text);
              if (t && open) setActive(indexOf(t));
              // A pasted 24 h time lands at once. While typing, "01:30" may still get "pm": wait for Enter or blur.
              if (!typing(e.nativeEvent) && /^\d{2}:\d{2}$/.test(text.trim()) && isHhmm(text.trim())) commit(text.trim());
            }}
            onClick={() => (phone || !open) && show()}
            onKeyDown={onKey}
            onBlur={(e) => {
              onBlur?.(e);
              if (draft !== null) commitTyped(draft);
            }}
            className={TEXT}
          />
          <button type="button" tabIndex={-1} aria-hidden data-slot="time-picker-icon" disabled={disabled} onClick={() => (open ? setOpen(false) : show())} className={ICON}>
            <Clock aria-hidden strokeWidth={1.5} className="pointer-events-none size-4" />
          </button>
        </div>
      </PickerAnchor>
      {name ? <input type="hidden" name={name} value={current} /> : null}
      <PickerContent
        label={props["aria-label"]}
        fallbackLabel={placeholder}
        anchor={wrap}
        focusOnClose={input}
        initialFocus={() => (phone ? list.current : null)}
        className={cn(!phone && "max-h-[min(280px,var(--radix-popover-content-available-height))]")}
      >
        {phone ? (
          <PhoneTimeColumns
            listId={listId}
            listRef={list}
            label={props["aria-label"] ?? placeholder}
            current={current}
            step={step}
            clearable={clearable}
            onCommit={commit}
            onDone={() => setOpen(false)}
          />
        ) : (
          <OptionList
            id={listId}
            listRef={list}
            tabIndex={-1}
            aria-label={props["aria-label"] ?? placeholder}
            options={options}
            selected={selected}
            active={active}
            onActive={moveTo}
            onPick={(i) => {
              commit(options[i].value);
              setOpen(false);
            }}
            onKeyDown={(e) => {
              const next = listKey(e.key, options, active);
              if (next !== null) {
                e.preventDefault();
                moveTo(next);
              } else if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (moved.current && options[active]) commit(options[active].value);
                setOpen(false);
              }
            }}
          />
        )}
      </PickerContent>
    </Picker>
  );
}

/**
 * The phone sheet's time: an hour column and a minute column (one row per step), so any time is a short
 * scroll away. An hour keeps the minute; a minute keeps the hour and closes. Clear empties the field.
 */
function PhoneTimeColumns({
  listId,
  listRef,
  label,
  current,
  step,
  clearable,
  onCommit,
  onDone,
}: {
  listId: string;
  listRef: RefObject<HTMLDivElement | null>;
  label: string;
  current: string;
  step: number;
  clearable: boolean;
  onCommit: (hhmm: string) => void;
  onDone: () => void;
}) {
  const minutes: PickerOption[] = useMemo(
    () => Array.from({ length: Math.max(1, Math.floor(60 / step)) }, (_, i) => ({ value: pad2(i * step), label: `:${pad2(i * step)}` })),
    [step],
  );
  const [hh, mm] = isHhmm(current) ? current.split(":") : ["", ""];
  const [hour, setHour] = useState(() => HOURS.findIndex((o) => o.value === (hh || "09")));
  const [minute, setMinute] = useState(() => Math.max(0, minutes.findIndex((o) => o.value === (mm ? nearestStep(current, step).slice(3) : "00"))));
  const pickHour = (i: number) => {
    setHour(i);
    onCommit(`${HOURS[i].value}:${mm || "00"}`);
  };
  const pickMinute = (i: number) => {
    setMinute(i);
    onCommit(`${hh || HOURS[hour].value}:${minutes[i].value}`);
    onDone();
  };
  const keys = (options: readonly PickerOption[], at: number, set: (i: number) => void, pick: (i: number) => void) => (e: KeyboardEvent<HTMLDivElement>) => {
    const next = listKey(e.key, options, at);
    if (next !== null) {
      e.preventDefault();
      set(next);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(at);
    }
  };
  return (
    <>
      <div className="flex min-h-0 flex-1 gap-2">
        <OptionList
          id={listId}
          listRef={listRef}
          tabIndex={-1}
          aria-label={`${label} hour`}
          className="flex-1"
          options={HOURS}
          selected={new Set(hh ? [hh] : [])}
          active={hour}
          onActive={setHour}
          onPick={pickHour}
          onKeyDown={keys(HOURS, hour, setHour, pickHour)}
        />
        <OptionList
          id={`${listId}-m`}
          tabIndex={-1}
          aria-label={`${label} minute`}
          className="flex-1"
          options={minutes}
          selected={new Set(mm ? [mm] : [])}
          active={minute}
          onActive={setMinute}
          onPick={pickMinute}
          onKeyDown={keys(minutes, minute, setMinute, pickMinute)}
        />
      </div>
      {clearable ? (
        <div className="mt-1 flex items-center border-t border-rule pt-1">
          <button
            type="button"
            disabled={!current}
            onClick={() => {
              onCommit("");
              onDone();
            }}
            className="ml-auto h-11 rounded-md px-2 text-label text-ink-3 outline-none transition-colors duration-200 hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-30"
          >
            Clear
          </button>
        </div>
      ) : null}
    </>
  );
}

export type DateTimePickerProps = Omit<FieldProps, "placeholder"> & {
  min?: string;
  max?: string;
  timeZone?: string;
  /** Time used when only a day is picked. Default 09:00. */
  defaultTime?: string;
};

/**
 * Day and time side by side. Drop-in for `<input type="datetime-local">`: the value is
 * `yyyy-mm-ddTHH:mm` or "". Picking a day without a time uses 09:00; a time without a day uses today.
 * Typing a whole `yyyy-mm-ddTHH:mm` into the day field sets both.
 */
export function DateTimePicker({
  value,
  defaultValue,
  onChange,
  onValueChange,
  name,
  id,
  disabled,
  className,
  timeZone,
  defaultTime = "09:00",
  min,
  max,
  ...props
}: DateTimePickerProps) {
  const [inner, setInner] = useState(defaultValue ?? "");
  const current = value !== undefined && value !== null ? value : value === null ? "" : inner;
  const { date, time } = splitDateTime(current);
  const send = emitter(name, onChange, onValueChange);
  const box = useRef<HTMLDivElement>(null);
  // Named by a <label htmlFor>, the time half takes that name too ("Alert time"), not just "Time".
  const [labelText, setLabelText] = useState<string>();
  useEffect(() => setLabelText(box.current?.querySelector("input")?.labels?.[0]?.textContent?.trim() || undefined), [id]);
  const label = props["aria-label"] ?? labelText;
  const set = (d: string, t: string) => {
    const next = d ? `${d}T${t || defaultTime}` : "";
    if (next === current) return;
    if (value === undefined) setInner(next);
    send(next);
  };
  return (
    <div ref={box} data-slot="date-time-picker" data-value={current} className={cn("flex min-w-0 flex-1 flex-wrap items-center gap-2", className)}>
      {/* Wraps: in a phone drawer row the time goes under the day instead of past the edge. */}
      <DatePicker
        {...props}
        id={id}
        value={date}
        min={min?.slice(0, 10)}
        max={max?.slice(0, 10)}
        timeZone={timeZone}
        disabled={disabled}
        className="min-w-[132px] flex-1"
        onChange={(e) => set(e.target.value, time)}
        onTypedTime={(d, t) => set(d, t)}
      />
      <TimePicker
        aria-label={label ? `${label} time` : "Time"}
        value={time}
        disabled={disabled}
        clearable={false}
        className="w-[116px] flex-none"
        onChange={(e) => set(date || todayDay(timeZone), e.target.value)}
      />
      {name ? <input type="hidden" name={name} value={current} /> : null}
    </div>
  );
}
