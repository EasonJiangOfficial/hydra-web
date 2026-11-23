import { z } from "zod";
import { addDays, wallClock, zonedInstant } from "@/lib/planning/dates";

/**
 * Routine schedules, read in the owner's time zone. The wall clock holds across DST (08:00 stays
 * 08:00; a time that does not exist on a spring-forward day runs at the first instant after it).
 * Monthly on the 29th to 31st runs on the month's last day when the month is shorter.
 */

export const scheduleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("daily"), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
  z.strictObject({ kind: z.literal("weekdays"), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
  z.strictObject({
    kind: z.literal("weekly"),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    /** 0 = Sunday ... 6 = Saturday. */
    days: z.array(z.int().min(0).max(6)).min(1).max(7),
  }),
  z.strictObject({ kind: z.literal("monthly"), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), day: z.int().min(1).max(31) }),
]);
export type Schedule = z.infer<typeof scheduleSchema>;

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const lastDayOfMonth = (date: string) => {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

function runsOn(s: Schedule, date: string): boolean {
  switch (s.kind) {
    case "daily":
      return true;
    case "weekdays":
      return weekday(date) >= 1 && weekday(date) <= 5;
    case "weekly":
      return s.days.includes(weekday(date));
    case "monthly":
      return Number(date.slice(8)) === Math.min(s.day, lastDayOfMonth(date));
  }
}

/** The first run strictly after `after`, in `tz`. */
export function nextRun(s: Schedule, after: Date, tz: string): Date {
  const start = wallClock(after, tz).date;
  for (let i = 0; i <= 62; i++) {
    const date = addDays(start, i);
    if (!runsOn(s, date)) continue;
    const at = zonedInstant(date, s.time, tz);
    if (at > after) return at;
  }
  throw new Error("schedule never runs");
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The schedule in plain words ("Weekdays at 08:00"). */
export function describeSchedule(s: Schedule): string {
  switch (s.kind) {
    case "daily":
      return `Every day at ${s.time}`;
    case "weekdays":
      return `Weekdays at ${s.time}`;
    case "weekly":
      return `Every ${[...s.days].sort().map((d) => DAY_NAMES[d]).join(", ")} at ${s.time}`;
    case "monthly":
      return `Monthly on day ${s.day} at ${s.time}`;
  }
}
