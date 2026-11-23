import { addDays, daysUntil, dayOf, wallClock, zonedInstant } from "./dates";
import { occurrencesBetween } from "./events";
import type { PlanningEvent, PlanningStatus, PlanningTask } from "./types";

/**
 * Alerts (DESIGN.md 6.9: a reminder is a task or event with an alert time). U4 stores the alert and
 * names what is due; U13 delivers it (Mac, browser, phone). Two rules keep delivery to one per
 * occurrence:
 * - An occurrence is (kind, item id, occurrence day). The database holds one row per claimed
 *   occurrence (planning_alert_fires), and `planning_claim_alert` is true for exactly one caller.
 *   So a cron overlap, a retry or a second device never delivers twice.
 * - Only alerts inside the lookback window are candidates, so a task reopened a week later, or a
 *   cron that was down for a day, never floods the owner with old alerts.
 */
export const ALERT_LOOKBACK_MS = 6 * 3_600_000;

export type AlertKind = "task" | "event";

export interface AlertCandidate {
  readonly kind: AlertKind;
  readonly itemId: string;
  /** The owner's day of this occurrence: the claim key. */
  readonly occurrenceOn: string;
  /** ISO instant the alert is due. */
  readonly alertAt: string;
  readonly title: string;
}

/**
 * The claim key of a task's alert: the alert's own day. A task has one alert, and only a change of
 * alert_at clears its fired marker (0040 planning_alert_fires_reset), so adding or clearing a due
 * date keeps the key and a fired alert is not sent again.
 */
export function taskOccurrenceOn(task: Pick<PlanningTask, "alertAt">, tz: string): string | null {
  return task.alertAt ? dayOf(task.alertAt, tz) : null;
}

/**
 * Where a repeat copy's alert lands: the source's alert is some days before or after its due date
 * at some wall clock time, and the copy keeps both (09:00 stays 09:00 across DST).
 */
export function shiftAlertForCopy(
  srcAlertAt: string,
  srcDue: string,
  newDue: string,
  tz: string,
): string {
  const { date, time } = wallClock(new Date(srcAlertAt), tz);
  return zonedInstant(addDays(newDue, daysUntil(date, srcDue)), time, tz).toISOString();
}

function inWindow(alertAt: Date, now: Date, lookbackMs: number): boolean {
  return alertAt <= now && alertAt.getTime() > now.getTime() - lookbackMs;
}

/** Task alerts due now. A done task is not alerted. */
export function dueTaskAlerts(
  tasks: readonly PlanningTask[],
  statuses: readonly PlanningStatus[],
  now: Date,
  tz: string,
  lookbackMs = ALERT_LOOKBACK_MS,
): AlertCandidate[] {
  const done = new Set(statuses.filter((s) => s.isDone).map((s) => s.id));
  return tasks.flatMap((t) => {
    if (!t.alertAt || done.has(t.statusId) || !inWindow(new Date(t.alertAt), now, lookbackMs)) return [];
    const occurrenceOn = taskOccurrenceOn(t, tz);
    return occurrenceOn ? [{ kind: "task" as const, itemId: t.id, occurrenceOn, alertAt: t.alertAt, title: t.title }] : [];
  });
}

/**
 * Event alerts due now, per occurrence. The alert keeps its lead time from the start of each
 * occurrence (10 minutes before stays 10 minutes before).
 */
export function dueEventAlerts(
  events: readonly PlanningEvent[],
  now: Date,
  tz: string,
  lookbackMs = ALERT_LOOKBACK_MS,
): AlertCandidate[] {
  return events.flatMap((e) => {
    if (!e.alertAt) return [];
    const offset = new Date(e.alertAt).getTime() - new Date(e.startsAt).getTime();
    // Occurrences whose start is early enough that start + offset lands in the window.
    const lo = new Date(now.getTime() - lookbackMs - offset);
    const hi = new Date(now.getTime() - offset);
    return occurrencesBetween(e, addDays(dayOf(lo.toISOString(), tz), -1), addDays(dayOf(hi.toISOString(), tz), 1), tz).flatMap(
      (o) => {
        const at = new Date(new Date(o.startsAt).getTime() + offset);
        return inWindow(at, now, lookbackMs)
          ? [{ kind: "event" as const, itemId: e.id, occurrenceOn: o.date, alertAt: at.toISOString(), title: e.title }]
          : [];
      },
    );
  });
}

/** Everything due now, oldest alert first. Claim each with planning_claim_alert before delivering. */
export function dueAlerts(
  snapshot: Pick<{ tasks: readonly PlanningTask[]; statuses: readonly PlanningStatus[]; events: readonly PlanningEvent[] }, "tasks" | "statuses" | "events">,
  now: Date,
  tz: string,
  lookbackMs = ALERT_LOOKBACK_MS,
): AlertCandidate[] {
  return [
    ...dueTaskAlerts(snapshot.tasks, snapshot.statuses, now, tz, lookbackMs),
    ...dueEventAlerts(snapshot.events, now, tz, lookbackMs),
  ].sort((a, b) => (a.alertAt < b.alertAt ? -1 : a.alertAt > b.alertAt ? 1 : 0));
}
