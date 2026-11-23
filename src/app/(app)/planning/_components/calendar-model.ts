import { addDays, dayOf, daysUntil, wallClock, zonedInstant } from "@/lib/planning/dates";
import { eventsBetween } from "@/lib/planning/events";
import { isDoneTask } from "@/lib/planning/tasks";
import type { PlanningEvent, PlanningFilters, PlanningStatus, PlanningTask } from "@/lib/planning/types";
import { financeDatesBetween, type FinanceDate, type FinanceFacts } from "@/lib/planning-metrics/finance-dates";

/** The month grid and what lands on each day. Pure: the Calendar view and the day panel share it. */

export type CalendarItem =
  | { kind: "task"; key: string; date: string; id: string; title: string; done: boolean; overdue: boolean; color: string | null }
  | { kind: "event"; key: string; date: string; id: string; title: string; time: string | null; repeats: boolean }
  | { kind: "finance"; key: string; date: string; finance: FinanceDate }
  | { kind: "reminder"; key: string; date: string; title: string; time: string; of: { type: "task" | "event"; id: string } };

const weekday = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

/** `yyyy-mm` of a day. */
export const monthOf = (date: string): string => date.slice(0, 7);

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

/** Every day the month grid shows, Sunday first, whole weeks, at least five rows. */
export function monthGrid(month: string): string[] {
  const first = `${month}-01`;
  const lead = weekday(first);
  const length = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const rows = Math.max(5, Math.ceil((lead + length) / 7));
  const start = addDays(first, -lead);
  return Array.from({ length: rows * 7 }, (_, i) => addDays(start, i));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const monthLabel = (month: string): string => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** "Saturday, November 21" */
export function dayHeading(date: string): string {
  return `${WEEKDAYS[weekday(date)]}, ${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
}

/** "9:00 AM" from "09:00". */
export function clockLabel(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Search and category narrow the events too; a picked goal hides them (events have no goal). */
export function filterEvents(events: readonly PlanningEvent[], filters: PlanningFilters): PlanningEvent[] {
  const needle = filters.search.trim().toLowerCase();
  const specificGoal = filters.goal !== "all" && filters.goal !== "none";
  if (specificGoal) return [];
  return events.filter((e) => {
    if (needle && !e.title.toLowerCase().includes(needle)) return false;
    if (filters.category === "none") return e.category === null;
    return filters.category === "all" || e.category === filters.category;
  });
}

export interface CalendarInput {
  readonly from: string;
  readonly to: string;
  readonly tasks: readonly PlanningTask[];
  readonly statuses: readonly PlanningStatus[];
  readonly events: readonly PlanningEvent[];
  readonly finance: FinanceFacts;
  readonly timeZone: string;
  readonly today: string;
  /** Left out when the finance dates are filtered away (a category or search is set). */
  readonly showFinance?: boolean;
}

const ORDER = { finance: 0, event: 1, task: 2, reminder: 3 } as const;

/** Items by day for [from, to]: finance dates, events, tasks, then reminders. */
export function buildCalendar(input: CalendarInput): Map<string, CalendarItem[]> {
  const { from, to, timeZone: tz, today } = input;
  const out = new Map<string, CalendarItem[]>();
  const put = (item: CalendarItem) => {
    if (item.date < from || item.date > to) return;
    const list = out.get(item.date) ?? [];
    list.push(item);
    out.set(item.date, list);
  };

  if (input.showFinance !== false) {
    for (const f of financeDatesBetween(input.finance, from, to, today)) put({ kind: "finance", key: f.id, date: f.date, finance: f });
  }

  for (const o of eventsBetween(input.events, from, to, tz)) {
    const e = o.event;
    put({
      kind: "event",
      key: `event:${e.id}:${o.date}`,
      date: o.date,
      id: e.id,
      title: e.title,
      time: e.allDay ? null : wallClock(new Date(o.startsAt), tz).time,
      repeats: e.repeat !== null,
    });
  }
  // An alert keeps its lead on every occurrence. An occurrence just outside the range can alert inside it.
  for (const e of input.events) {
    if (!e.alertAt) continue;
    const lead = new Date(e.startsAt).getTime() - new Date(e.alertAt).getTime();
    for (const o of eventsBetween([e], addDays(from, -1), addDays(to, 1), tz)) {
      const at = new Date(new Date(o.startsAt).getTime() - lead);
      const w = wallClock(at, tz);
      put({ kind: "reminder", key: `reminder:event:${e.id}:${o.date}`, date: w.date, title: e.title, time: w.time, of: { type: "event", id: e.id } });
    }
  }

  for (const t of input.tasks) {
    const done = isDoneTask(t, input.statuses);
    if (t.dueDate) {
      const color = input.statuses.find((s) => s.id === t.statusId)?.color ?? null;
      put({ kind: "task", key: `task:${t.id}`, date: t.dueDate, id: t.id, title: t.title, done, overdue: !done && t.dueDate < today, color });
    }
    if (t.alertAt && !done) {
      const w = wallClock(new Date(t.alertAt), tz);
      put({ kind: "reminder", key: `reminder:task:${t.id}`, date: w.date, title: t.title, time: w.time, of: { type: "task", id: t.id } });
    }
  }

  for (const list of out.values()) {
    list.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || timeOf(a).localeCompare(timeOf(b)));
  }
  return out;
}

const timeOf = (item: CalendarItem): string =>
  item.kind === "event" ? (item.time ?? "") : item.kind === "reminder" ? item.time : "";

/** Whole days between two days: how far a drop moved an item. */
export const daysBetween = (from: string, to: string): number => daysUntil(to, from);

export interface EventTiming {
  readonly date: string;
  readonly allDay: boolean;
  /** HH:MM. Ignored for an all-day event. */
  readonly start: string;
  /** HH:MM or null for no end. Ignored for an all-day event. */
  readonly end: string | null;
}

/** An event's timing as the editor shows it: the first occurrence's day and times. */
export function timingOf(event: Pick<PlanningEvent, "startsAt" | "endsAt" | "allDay">, tz: string): EventTiming {
  const s = wallClock(new Date(event.startsAt), tz);
  return {
    date: s.date,
    allDay: event.allDay,
    start: event.allDay ? "09:00" : s.time,
    end: event.endsAt && !event.allDay ? wallClock(new Date(event.endsAt), tz).time : null,
  };
}

/**
 * The patch for new timing. The alert moves with the start so it keeps its lead. An end at or
 * before the start is dropped.
 */
export function timingPatch(
  event: Pick<PlanningEvent, "startsAt" | "alertAt">,
  next: EventTiming,
  tz: string,
): { startsAt: string; endsAt: string | null; allDay: boolean; alertAt: string | null } {
  const start = zonedInstant(next.date, next.allDay ? "00:00" : next.start, tz);
  const end = !next.allDay && next.end ? zonedInstant(next.date, next.end, tz) : null;
  const shift = start.getTime() - new Date(event.startsAt).getTime();
  return {
    startsAt: start.toISOString(),
    endsAt: end && end > start ? end.toISOString() : null,
    allDay: next.allDay,
    alertAt: event.alertAt ? new Date(new Date(event.alertAt).getTime() + shift).toISOString() : null,
  };
}

/** The day an item's source row starts on, for a repeating event's first occurrence. */
export const firstDay = (event: Pick<PlanningEvent, "startsAt">, tz: string): string => dayOf(event.startsAt, tz);
