import { TZDate } from "@date-fns/tz";

/**
 * Day math in the owner's time zone (settings.time_zone). Every function takes the zone, so
 * nothing reads the clock or the machine's zone: tests inject `now`. A day is `yyyy-mm-dd`.
 */
export const DEFAULT_TIME_ZONE = "America/Toronto";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const formats = new Map<string, Intl.DateTimeFormat>();
function parts(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formats.set(tz, f);
  }
  return f;
}

let zones: Map<string, string> | undefined;

/**
 * The IANA name for `tz` (any case; a link like Asia/Kolkata resolves to the name Intl lists),
 * or null. Only IANA names and "UTC": an offset ("+05:00", "-05") or an abbreviation
 * ("EST") is refused, because Postgres reads a POSIX offset with the opposite sign.
 */
export function canonicalTimeZone(tz: string): string | null {
  zones ??= new Map(["UTC", ...Intl.supportedValuesOf("timeZone")].map((z) => [z.toLowerCase(), z]));
  const key = tz.trim().toLowerCase();
  if (zones.has(key)) return zones.get(key)!;
  // An Area/Location link only: Intl maps a bare "EST" to America/Panama, which is not what was meant.
  if (!key.includes("/")) return null;
  try {
    return zones.get(new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() }).resolvedOptions().timeZone.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

/** An IANA zone name (see canonicalTimeZone). */
export function isTimeZone(tz: string): boolean {
  return canonicalTimeZone(tz) !== null;
}

/** Wall clock of an instant in `tz`: its day and `HH:MM`. */
export function wallClock(at: Date, tz: string): { date: string; time: string } {
  const p = parts(tz).formatToParts(at);
  const get = (t: string): string => p.find((x) => x.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/** `yyyy-mm-dd` of the instant in `tz`. */
export function todayIn(now: Date, tz: string): string {
  return wallClock(now, tz).date;
}

/** The day an ISO timestamp falls on in `tz`. */
export function dayOf(iso: string, tz: string): string {
  return todayIn(new Date(iso), tz);
}

/** The instant a wall clock (`yyyy-mm-dd`, `HH:MM`) happens in `tz`. DST safe: 09:00 stays 09:00. */
export function zonedInstant(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(new TZDate(y, m - 1, d, hh, mm, 0, tz).getTime());
}

const utcDay = (date: string): number => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

export function addDays(date: string, n: number): string {
  return new Date(utcDay(date) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Calendar days from `today` to `date` (negative when past). */
export function daysUntil(date: string, today: string): number {
  return Math.round((utcDay(date) - utcDay(today)) / 86_400_000);
}

/** First and last day of the month `date` is in. */
export function monthBounds(date: string): { from: string; to: string } {
  const [y, m] = date.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

export type DueTone = "overdue" | "today" | "future";

export function dueTone(dueDate: string | null, today: string): DueTone | null {
  if (dueDate === null) return null;
  const days = daysUntil(dueDate, today);
  if (days < 0) return "overdue";
  return days === 0 ? "today" : "future";
}

export interface DeadlineLabel {
  readonly text: string;
  readonly tone: "overdue" | "today" | "upcoming" | "achieved" | "none";
}

export function deadlineLabel(deadline: string | null, today: string, achieved: boolean): DeadlineLabel {
  if (achieved) {
    return { text: deadline === null ? "Achieved" : formatDay(deadline, today), tone: "achieved" };
  }
  if (deadline === null) return { text: "No date", tone: "none" };
  const days = daysUntil(deadline, today);
  if (days === 0) return { text: "Due today", tone: "today" };
  if (days > 0) return { text: days === 1 ? "1 day left" : `${days} days left`, tone: "upcoming" };
  const late = -days;
  return { text: late === 1 ? "1 day overdue" : `${late} days overdue`, tone: "overdue" };
}

/** "Nov 24"; the year is added when it differs from today's year. */
export function formatDay(date: string, today: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const label = `${MONTHS[m - 1]} ${d}`;
  return y === Number(today.slice(0, 4)) ? label : `${label}, ${y}`;
}

/** "Nov 24, 9:00 AM" in `tz`. */
export function formatStamp(iso: string, tz: string, today: string): string {
  const { date, time } = wallClock(new Date(iso), tz);
  const [h, m] = time.split(":").map(Number);
  const clock = `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  return `${formatDay(date, today)}, ${clock}`;
}

/** `yyyy-mm-ddTHH:MM` for a datetime-local input, in `tz`; "" for null. */
export function toLocalInput(iso: string | null, tz: string): string {
  if (!iso) return "";
  const { date, time } = wallClock(new Date(iso), tz);
  return `${date}T${time}`;
}

/** The instant a datetime-local value means in `tz`; null for "" or junk. */
export function fromLocalInput(value: string, tz: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  return m ? zonedInstant(m[1], m[2], tz).toISOString() : null;
}
