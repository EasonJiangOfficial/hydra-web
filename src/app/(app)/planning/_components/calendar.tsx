"use client";

import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Bell, ChevronLeft, ChevronRight } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";

import { Button, Card, cn, formatMoney } from "@/components/kit";
import { holdSelection, pickUpTick, settle } from "@/components/planning/drag-motion";
import { usePlanning } from "@/components/planning/planning-store";
import { ColorDot } from "@/components/ui/color-picker";
import type { PlanningEvent, PlanningTask } from "@/lib/planning/types";

import { buildCalendar, clockLabel, dayHeading, daysBetween, monthGrid, monthLabel, monthOf, shiftMonth, type CalendarItem } from "./calendar-model";
import { useOpenDay } from "./day-drawer";
import { usePlanningExtras } from "./extras";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Chips shown in a desktop cell before "+N more". */
const VISIBLE = 3;

const chipClass = (item: CalendarItem): string => {
  const base =
    "flex min-w-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-left text-tag leading-[1.35] outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink";
  switch (item.kind) {
    case "event":
      return cn(base, "bg-ink text-white");
    case "task":
      return cn(base, "bg-tint", item.done ? "text-ink-3 line-through" : item.overdue ? "text-neg" : "text-ink");
    case "finance":
      return cn(base, item.finance.kind === "payout" ? "border border-ink text-ink" : "border border-dashed border-ink-3 text-ink");
    case "reminder":
      return cn(base, "text-ink-3");
  }
};

const dotClass = (item: CalendarItem): string => {
  switch (item.kind) {
    case "event":
      // A square, like the event's filled chip, so a task dot in an ink status color still differs.
      return "rounded-[1px] bg-ink";
    case "task":
      return "bg-ink-3";
    case "finance":
      return item.finance.kind === "payout" ? "border border-ink bg-surface" : "border border-dashed border-ink-3 bg-surface";
    case "reminder":
      return "bg-rule-2";
  }
};

/** What a chip says. Used by the chip, the drag preview and the accessible name. */
export function itemText(item: CalendarItem): string {
  switch (item.kind) {
    case "event":
      return item.time ? `${clockLabel(item.time)} ${item.title}` : item.title;
    case "task":
    case "reminder":
      return item.title;
    case "finance":
      return item.finance.amountCents !== null
        ? `${item.finance.label} ${formatMoney(item.finance.amountCents, { whole: true })}`
        : item.finance.label;
  }
}

const dragId = (item: CalendarItem): string | null =>
  item.kind === "task" ? `task:${item.id}:${item.date}` : item.kind === "event" ? `event:${item.id}:${item.date}` : null;

function Chip({ item, justDragged, onOpen }: { item: CalendarItem; justDragged: RefObject<boolean>; onOpen: (item: CalendarItem) => void }) {
  const id = dragId(item);
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({ id: id ?? item.key, disabled: id === null });
  const label = itemText(item);
  const kind = item.kind === "finance" ? `${item.finance.kind === "payout" ? "Payout" : item.finance.kind === "tax" ? "Tax date" : "Card due date"}: ` : item.kind === "reminder" ? "Reminder: " : item.kind === "event" ? "Event: " : "Task: ";
  return (
    <button
      ref={setNodeRef}
      type="button"
      data-cal-item={item.kind}
      data-item-key={item.key}
      aria-label={`${kind}${label}`}
      title={item.kind === "event" && item.repeats ? "Repeats. Moving it moves the whole series." : undefined}
      {...(id ? attributes : {})}
      {...(id ? listeners : {})}
      onClick={() => !justDragged.current && onOpen(item)}
      className={cn(
        chipClass(item),
        id && "cursor-grab touch-manipulation select-none active:cursor-grabbing [-webkit-touch-callout:none]",
        // The slot the held chip leaves: a quiet tint, no content.
        isDragging && "bg-hover text-transparent outline-1 -outline-offset-1 outline-dashed outline-rule-2 *:opacity-0",
      )}
    >
      {item.kind === "reminder" ? <Bell aria-hidden strokeWidth={1.5} className="size-3 shrink-0" /> : null}
      {item.kind === "task" ? <ColorDot color={item.color} className="size-1.5" /> : null}
      <span className="truncate">{item.kind === "reminder" ? `${clockLabel(item.time)} ${item.title}` : label}</span>
    </button>
  );
}

function DayCell({
  date,
  inMonth,
  today,
  items,
  justDragged,
  onOpenDay,
  onOpenItem,
}: {
  date: string;
  inMonth: boolean;
  today: boolean;
  items: readonly CalendarItem[];
  justDragged: RefObject<boolean>;
  onOpenDay: (date: string) => void;
  onOpenItem: (item: CalendarItem) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: date });
  const shown = items.slice(0, VISIBLE);
  const extra = items.length - shown.length;
  const dayNumber = Number(date.slice(8, 10));
  return (
    <div
      ref={setNodeRef}
      data-testid={`cal-day-${date}`}
      data-date={date}
      data-drop-target={isOver || undefined}
      onClick={(e) => e.target === e.currentTarget && !justDragged.current && onOpenDay(date)}
      className={cn(
        "relative flex min-h-[3.75rem] min-w-0 flex-col gap-1 border-r border-b border-rule p-1 transition-colors duration-200 sm:min-h-[7.5rem] sm:p-1.5",
        !inMonth && "bg-tint/60",
        isOver && "bg-hover outline-1 -outline-offset-1 outline-ink",
      )}
    >
      <button
        type="button"
        onClick={() => onOpenDay(date)}
        aria-label={`Open ${dayHeading(date)}`}
        aria-current={today ? "date" : undefined}
        className={cn(
          "grid size-6 shrink-0 place-items-center self-start rounded-full text-tag tabular-nums outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink",
          today ? "bg-ink text-white" : inMonth ? "text-ink" : "text-ink-3",
        )}
      >
        {dayNumber}
      </button>
      {/* Phone: the day's items as dots; the day panel lists them. */}
      <div className="flex flex-wrap content-start gap-0.5 sm:hidden" aria-hidden>
        {items.slice(0, 6).map((item) => (
          <span
            key={item.key}
            className={cn("size-1.5 rounded-full", dotClass(item))}
            style={item.kind === "task" && item.color ? { background: item.color } : undefined}
          />
        ))}
      </div>
      <div className="hidden min-w-0 flex-col gap-0.5 sm:flex">
        {shown.map((item) => (
          <Chip key={item.key} item={item} justDragged={justDragged} onOpen={onOpenItem} />
        ))}
        {extra > 0 ? (
          <button
            type="button"
            onClick={() => onOpenDay(date)}
            className="self-start rounded-sm px-1.5 text-tag text-ink-3 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink"
          >
            +{extra} more
          </button>
        ) : null}
      </div>
    </div>
  );
}

const LEGEND: { label: string; cls: string }[] = [
  { label: "Task", cls: "bg-tint text-ink" },
  { label: "Event", cls: "bg-ink text-white" },
  { label: "Bill or tax date", cls: "border border-dashed border-ink-3 text-ink" },
  { label: "Payout", cls: "border border-ink text-ink" },
];

/**
 * The month grid. Tasks, events and read-only finance dates (card due dates, tax dates, expected
 * payouts) and reminders. Drag a task or an event to another day to move it; finance dates and
 * reminders stay put. A click on a day opens its panel.
 */
export function CalendarView({ tasks, events }: { tasks: readonly PlanningTask[]; events: readonly PlanningEvent[] }) {
  const { snapshot, today, timeZone, updateTask, openTask } = usePlanning();
  const extras = usePlanningExtras();
  const openDay = useOpenDay();
  const dndId = useId();
  const [month, setMonth] = useState(() => monthOf(today));
  const [active, setActive] = useState<CalendarItem | null>(null);
  const justDragged = useRef(false);
  const reduced = useReducedMotion() ?? false;
  const gridRef = useRef<HTMLDivElement>(null);
  const liftedRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );

  // A drag cut short by an unmount (a view or route change) never reaches finish().
  useEffect(() => () => holdSelection(false), []);

  const days = useMemo(() => monthGrid(month), [month]);
  const items = useMemo(
    () =>
      buildCalendar({
        from: days[0],
        to: days[days.length - 1],
        tasks,
        statuses: snapshot.statuses,
        events,
        finance: extras.facts,
        timeZone,
        today,
      }),
    [days, tasks, snapshot.statuses, events, extras.facts, timeZone, today],
  );

  function open(item: CalendarItem): void {
    if (item.kind === "task") openTask(item.id);
    else if (item.kind === "reminder" && item.of.type === "task") openTask(item.of.id);
    else if (item.kind === "event") openDay(item.date, item.id);
    else if (item.kind === "reminder") openDay(item.date, item.of.id);
    else openDay(item.date);
  }

  /** Ends a drag; the chip settles into the day the next commit puts it on (`dropped` is its key then). */
  function finish(dropped: string | null): void {
    if (dropped) {
      settle({ root: gridRef.current, attr: "data-item-key", dropped, lifted: liftedRef.current?.getBoundingClientRect() ?? null, before: new Map(), reduced });
    }
    holdSelection(false);
    setActive(null);
    justDragged.current = true;
    window.setTimeout(() => {
      justDragged.current = false;
    }, 0);
  }

  /** The chip's key on `date` (a task chip keeps its key; an event chip's key carries the day). */
  const keyOn = (kind: string, id: string, date: string): string => (kind === "task" ? `task:${id}` : `event:${id}:${date}`);

  function onDragStart(e: DragStartEvent): void {
    pickUpTick(e.activatorEvent);
    holdSelection(true);
    const [kind, id, date] = String(e.active.id).split(":");
    setActive((items.get(date) ?? []).find((i) => (i.kind === "task" || i.kind === "event") && i.kind === kind && i.id === id) ?? null);
  }

  function onDragEnd(e: DragEndEvent): void {
    const [kind, id, from] = String(e.active.id).split(":");
    const to = e.over ? String(e.over.id) : from;
    finish(keyOn(kind, id, to));
    if (to === from) return;
    if (kind === "task") void updateTask(id, { dueDate: to });
    else if (kind === "event") void extras.shiftEvent(id, daysBetween(from, to));
  }

  return (
    <Card className="gap-3 p-4 max-sm:p-3" data-testid="calendar">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon-sm" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
          <ChevronLeft aria-hidden strokeWidth={1.5} />
        </Button>
        <h2 className="min-w-[8.5rem] text-center text-body font-medium" aria-live="polite" data-testid="cal-month">
          {monthLabel(month)}
        </h2>
        <Button variant="outline" size="icon-sm" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>
          <ChevronRight aria-hidden strokeWidth={1.5} />
        </Button>
        <Button variant="ghost" onClick={() => setMonth(monthOf(today))} disabled={month === monthOf(today)}>
          Today
        </Button>
        <div className="flex-1" />
        <ul className="flex flex-wrap items-center gap-1.5 max-sm:hidden" aria-label="Legend">
          {LEGEND.map((l) => (
            <li key={l.label} className={cn("rounded-sm px-1.5 py-0.5 text-tag", l.cls)}>
              {l.label}
            </li>
          ))}
        </ul>
      </div>

      <DndContext id={dndId} sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}
        onDragCancel={(e) => {
          const [kind, id, date] = String(e.active.id).split(":");
          finish(keyOn(kind, id, date));
        }}
      >
        <div ref={gridRef} className="border-t border-l border-rule" role="grid" aria-label={monthLabel(month)}>
          <div className="grid grid-cols-7" role="row">
            {WEEKDAYS.map((d) => (
              <div key={d} role="columnheader" className="border-r border-b border-rule px-1.5 py-1 text-tag text-ink-3">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {days.map((date) => (
              <DayCell
                key={date}
                date={date}
                inMonth={monthOf(date) === month}
                today={date === today}
                items={items.get(date) ?? []}
                justDragged={justDragged}
                onOpenDay={openDay}
                onOpenItem={open}
              />
            ))}
          </div>
        </div>
        {/* No built-in drop animation: settle() glides the real chip in from the lifted copy. */}
        <DragOverlay dropAnimation={null}>
          {active ? (
            <div
              ref={liftedRef}
              aria-hidden
              className={cn(
                chipClass(active),
                "pointer-events-none h-full cursor-grabbing ring-1 ring-ink transition-[scale,rotate] duration-150 ease-hydra motion-safe:scale-[1.02] motion-safe:rotate-1 motion-safe:starting:scale-100 motion-safe:starting:rotate-0",
              )}
            >
              <span className="truncate">{itemText(active)}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </Card>
  );
}
