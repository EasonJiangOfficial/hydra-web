import { z } from "zod";

/**
 * Repeats for tasks and events. A repeating task is a series of copies, one per period; a copy's
 * next date comes from its own due date and rule. Monthly keeps the series' day of month
 * (`anchorDay`), clamped to the month's last day: Jan 31 -> Feb 28 -> Mar 31.
 */
export const REPEAT_RULES = ["daily", "weekdays", "weekly", "monthly"] as const;
export type RepeatRule = (typeof REPEAT_RULES)[number];
export const repeatRuleSchema = z.enum(REPEAT_RULES);

export const REPEAT_LABELS: Readonly<Record<RepeatRule, string>> = {
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  monthly: "Monthly",
};

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The date after `due` for `rule` (all dates `yyyy-mm-dd`). */
export function nextRepeatDate(due: string, rule: RepeatRule, anchorDay: number): string {
  const [y, m, d] = due.split("-").map(Number);
  if (rule === "monthly") {
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return iso(Date.UTC(y, m, Math.min(anchorDay, lastDay)));
  }
  if (rule === "weekly") return iso(Date.UTC(y, m - 1, d + 7));
  let next = Date.UTC(y, m - 1, d + 1);
  if (rule === "weekdays") {
    const day = new Date(next).getUTCDay();
    if (day === 6) next += 2 * 86_400_000;
    else if (day === 0) next += 86_400_000;
  }
  return iso(next);
}

/**
 * Every copy date due after `latest` up to `through` (inclusive), oldest first, at most `cap`.
 * Dates before `since` (the day the repeat turned on) are skipped and not counted: no late copies
 * for days it was not repeating. Empty while the next date is still ahead.
 */
export function dueRepeatDates(
  latest: string,
  rule: RepeatRule,
  anchorDay: number,
  through: string,
  cap: number,
  since = "",
): string[] {
  const dates: string[] = [];
  let date = nextRepeatDate(latest, rule, anchorDay);
  while (date <= through && dates.length < cap) {
    if (date >= since) dates.push(date);
    date = nextRepeatDate(date, rule, anchorDay);
  }
  return dates;
}
