import { addDays, daysUntil, wallClock, zonedInstant } from "./dates";
import { nextRepeatDate } from "./repeat";
import type { PlanningEvent } from "./types";

export interface EventOccurrence {
  readonly eventId: string;
  /** The owner's day this occurrence starts on. */
  readonly date: string;
  /** ISO instants. */
  readonly startsAt: string;
  readonly endsAt: string | null;
}

/** ponytail: walks the series from its first day; years of daily repeats stay far below this. */
const MAX_STEPS = 20_000;

/**
 * The occurrences of one event whose start day falls in [from, to] (owner's days, inclusive), oldest
 * first, at most `cap`. A repeating event is one row: each occurrence keeps the first one's wall
 * clock time in `tz` (09:00 stays 09:00 across DST) and its length. Monthly keeps the first day of
 * month, clamped to short months.
 */
export function occurrencesBetween(
  event: Pick<PlanningEvent, "id" | "startsAt" | "endsAt" | "allDay" | "repeat">,
  from: string,
  to: string,
  tz: string,
  cap = 500,
): EventOccurrence[] {
  const first = wallClock(new Date(event.startsAt), tz);
  const time = event.allDay ? "00:00" : first.time;
  const lengthMs = event.endsAt ? new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime() : null;
  const anchorDay = Number(first.date.slice(8, 10));
  const out: EventOccurrence[] = [];
  let date = first.date;
  for (let i = 0; i < MAX_STEPS && date <= to && out.length < cap; i += 1) {
    if (date >= from) {
      const start = i === 0 ? new Date(event.startsAt) : zonedInstant(date, time, tz);
      out.push({
        eventId: event.id,
        date,
        startsAt: start.toISOString(),
        endsAt: lengthMs === null ? null : new Date(start.getTime() + lengthMs).toISOString(),
      });
    }
    if (!event.repeat) break;
    date = nextRepeatDate(date, event.repeat, anchorDay);
  }
  return out;
}

/** Every event's occurrences in [from, to], soonest first. */
export function eventsBetween(
  events: readonly PlanningEvent[],
  from: string,
  to: string,
  tz: string,
): (EventOccurrence & { event: PlanningEvent })[] {
  return events
    .flatMap((event) => occurrencesBetween(event, from, to, tz).map((o) => ({ ...o, event })))
    .sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0));
}

/** The event moved to start on `toDate`, same wall clock and length. ISO instants. */
export function moveEventToDay(
  event: Pick<PlanningEvent, "startsAt" | "endsAt" | "alertAt">,
  toDate: string,
  tz: string,
): { startsAt: string; endsAt: string | null; alertAt: string | null } {
  const { date } = wallClock(new Date(event.startsAt), tz);
  const shift = daysUntil(toDate, date);
  const move = (iso: string): string => {
    const w = wallClock(new Date(iso), tz);
    return zonedInstant(addDays(w.date, shift), w.time, tz).toISOString();
  };
  return {
    startsAt: move(event.startsAt),
    endsAt: event.endsAt ? move(event.endsAt) : null,
    alertAt: event.alertAt ? move(event.alertAt) : null,
  };
}
