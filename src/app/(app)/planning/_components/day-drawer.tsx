"use client";

import { Bell } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";

import { DetailDrawer, InfoDot, Label, cn, drawerHref, formatMoney, setDrawerUrl } from "@/components/kit";
import { usePlanning } from "@/components/planning/planning-store";
import { ColorDot } from "@/components/ui/color-picker";
import { isDoneTask } from "@/lib/planning/tasks";

import { buildCalendar, clockLabel, dayHeading, timingOf, type CalendarItem } from "./calendar-model";
import { EventEditor } from "./event-editor";
import { usePlanningExtras } from "./extras";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Opens `?day=` (one panel at a time) and, when given, the event to edit inside it. */
export function useOpenDay(): (date: string, eventId?: string) => void {
  const pathname = usePathname();
  const search = useSearchParams();
  const { selectEvent } = usePlanningExtras();
  return useCallback(
    (date, eventId) => {
      const next = new URLSearchParams(search.toString());
      next.delete("task");
      next.delete("goal");
      selectEvent(eventId ?? null);
      setDrawerUrl(drawerHref(pathname, next, "day", date), true);
    },
    [pathname, search, selectEvent],
  );
}

/** A task or goal opening closes the day panel: one panel at a time. */
function useOnePanel(): void {
  const pathname = usePathname();
  const search = useSearchParams();
  const crowded = search.has("day") && (search.has("task") || search.has("goal"));
  useEffect(() => {
    if (!crowded) return;
    const next = new URLSearchParams(search.toString());
    next.delete("day");
    const qs = next.toString();
    setDrawerUrl(qs ? `${pathname}?${qs}` : pathname);
  }, [crowded, pathname, search]);
}

function AddRow({ label, placeholder, onAdd }: { label: string; placeholder: string; onAdd: (title: string) => Promise<void> }) {
  const [title, setTitle] = useState("");
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Escape") setTitle("");
    else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const text = title.trim();
      if (!text) return;
      setTitle("");
      void onAdd(text);
    }
  }
  return (
    <input
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={onKeyDown}
      aria-label={label}
      placeholder={placeholder}
      className="h-[34px] w-full rounded-lg border border-dashed border-rule-2 bg-transparent px-3 text-body text-ink outline-none transition-colors duration-200 placeholder:text-ink-3 focus:border-solid focus:border-ink"
    />
  );
}

function Section({ title, info, children }: { title: string; info?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5" aria-label={title}>
      <span className="flex items-center gap-1.5">
        <Label>{title}</Label>
        {info ? <InfoDot>{info}</InfoDot> : null}
      </span>
      {children}
    </section>
  );
}

const rowClass =
  "flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body outline-none transition-colors duration-200 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink";

function DayPanel({ date }: { date: string }) {
  const store = usePlanning();
  const extras = usePlanningExtras();
  const { snapshot, today, timeZone, openTask, createTask } = store;
  const items = useMemo(
    () =>
      buildCalendar({
        from: date,
        to: date,
        tasks: snapshot.tasks,
        statuses: snapshot.statuses,
        events: extras.events,
        finance: extras.facts,
        timeZone,
        today,
      }).get(date) ?? [],
    [date, snapshot.tasks, snapshot.statuses, extras.events, extras.facts, timeZone, today],
  );
  const of = <K extends CalendarItem["kind"]>(kind: K) => items.filter((i): i is Extract<CalendarItem, { kind: K }> => i.kind === kind);
  const tasks = of("task");
  const events = of("event");
  const finance = of("finance");
  const reminders = of("reminder");
  const firstOpen = [...snapshot.statuses].sort((a, b) => a.position - b.position).find((s) => !s.isDone);
  const openDay = useOpenDay();
  const openEvent = (id: string) => {
    const e = extras.events.find((x) => x.id === id);
    if (e) openDay(timingOf(e, timeZone).date, id);
  };
  const selected = extras.events.find((e) => e.id === extras.selectedEventId) ?? null;

  return (
    <div className="flex flex-col gap-5" data-day-panel={date}>
      <h3 className="text-section">{dayHeading(date)}</h3>

      <div className="flex flex-col gap-2">
        <AddRow
          label="Add a task to this day"
          placeholder="+ New task, press Enter"
          onAdd={async (title) => {
            if (firstOpen) await createTask({ title, statusId: firstOpen.id, dueDate: date });
          }}
        />
        <AddRow
          label="Add an event to this day"
          placeholder="+ New event, press Enter"
          onAdd={async (title) => {
            const id = await extras.createEvent({ title, date });
            if (id) extras.selectEvent(id);
          }}
        />
      </div>

      {events.length > 0 ? (
        <Section title="Events">
          {events.map((e) => (
            <div key={e.key} className="flex flex-col gap-2">
              <button
                type="button"
                aria-expanded={extras.selectedEventId === e.id}
                onClick={() => extras.selectEvent(extras.selectedEventId === e.id ? null : e.id)}
                className={cn(rowClass, extras.selectedEventId === e.id && "bg-tint")}
              >
                <span className="w-16 shrink-0 text-label text-ink-3 tabular-nums">{e.time ? clockLabel(e.time) : "All day"}</span>
                <span className="flex-1 truncate">{e.title}</span>
                {e.repeats ? <span className="text-tag text-ink-3">Repeats</span> : null}
              </button>
              {selected && selected.id === e.id ? <EventEditor key={selected.id} event={selected} /> : null}
            </div>
          ))}
        </Section>
      ) : null}

      {tasks.length > 0 ? (
        <Section title="Tasks">
          {tasks.map((t) => {
            const task = snapshot.tasks.find((x) => x.id === t.id);
            const status = snapshot.statuses.find((s) => s.id === task?.statusId);
            return (
              <button key={t.key} type="button" onClick={() => openTask(t.id)} aria-label={`Open ${t.title}`} className={rowClass}>
                <span className={cn("flex-1 truncate", t.done && "text-ink-3 line-through", t.overdue && "text-neg")}>{t.title}</span>
                <ColorDot color={status?.color} className="size-1.5" />
                <span className="text-tag text-ink-3">{task && isDoneTask(task, snapshot.statuses) ? "Done" : status?.label}</span>
              </button>
            );
          })}
        </Section>
      ) : null}

      {finance.length > 0 ? (
        <Section title="From your money" info="These dates come from your accounts and deals. They cannot be moved here.">
          {finance.map((f) => (
            <div key={f.key} className="flex min-h-9 items-center gap-2 rounded-lg border border-dashed border-rule-2 px-2 py-1.5 text-body" data-finance-row={f.finance.kind}>
              <span className="flex-1 truncate">{f.finance.label}</span>
              {f.finance.amountCents !== null ? <span className="tabular-nums">{formatMoney(f.finance.amountCents, { whole: true })}</span> : null}
            </div>
          ))}
        </Section>
      ) : null}

      {reminders.length > 0 ? (
        <Section title="Reminders">
          {reminders.map((r) => (
            <button
              key={r.key}
              type="button"
              className={rowClass}
              onClick={() => (r.of.type === "task" ? openTask(r.of.id) : openEvent(r.of.id))}
            >
              <Bell aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-ink-3" />
              <span className="w-16 shrink-0 text-label text-ink-3 tabular-nums">{clockLabel(r.time)}</span>
              <span className="flex-1 truncate">{r.title}</span>
            </button>
          ))}
        </Section>
      ) : null}

      {items.length === 0 ? <p className="text-label text-ink-3">Nothing on this day yet.</p> : null}
    </div>
  );
}

/** The kit's slide-out for `?day=yyyy-mm-dd`: that day's items, and quick add for a task or an event. */
export function DayDrawer() {
  useOnePanel();
  return (
    <DetailDrawer param="day" label="Day">
      {(date) => (DAY.test(date) ? <DayPanel date={date} /> : <p className="text-label text-ink-3">That is not a day.</p>)}
    </DetailDrawer>
  );
}
