import { TZDate, tz } from "@date-fns/tz";
import { addDays, addMonths, endOfMonth, format, isValid, parse, startOfMonth, startOfWeek } from "date-fns";

import { DEFAULT_TIME_ZONE, todayIn } from "@/lib/planning/dates";

/**
 * Date math for the custom date, time and calendar controls. A day is a plain `yyyy-mm-dd` string in the
 * owner's zone; every Date here is a TZDate pinned to UTC, so date-fns does calendar math only and no
 * machine zone or DST change can shift a day. "Today" comes from the owner's zone through `todayIn`.
 */

const UTC = tz("UTC");
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** [year, month 1-12, day] of a real `yyyy-mm-dd` day, else null. Plain math, so it is safe while rendering. */
function ymd(iso: string | null | undefined): [number, number, number] | null {
  const m = iso ? ISO_DAY.exec(iso) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? [y, mo, d] : null;
}

/**
 * The day as a UTC-pinned date, or null when it is not a real `yyyy-mm-dd` day. TZDate reads the clock
 * when built, so only the open calendar and typing use it, never the closed field's render.
 */
export function toDay(iso: string | null | undefined): TZDate | null {
  const p = ymd(iso);
  return p ? new TZDate(Date.UTC(p[0], p[1] - 1, p[2]), "UTC") : null;
}

export const isoOf = (d: Date): string => format(d, "yyyy-MM-dd", { in: UTC });

export const isIsoDay = (s: string | null | undefined): s is string => ymd(s) !== null;

/** "Nov 21, 2026", the owner's style. Empty for no date. */
export function formatDay(iso: string | null | undefined): string {
  const p = ymd(iso);
  return p ? `${MONTHS[p[1] - 1]} ${p[2]}, ${p[0]}` : "";
}

/** "November 2026". */
export const formatMonth = (iso: string): string => format(toDay(iso)!, "MMMM yyyy", { in: UTC });

export function shiftDays(iso: string, n: number): string {
  return isoOf(addDays(toDay(iso)!, n, { in: UTC }));
}

/** Same day of another month, clamped to its last day (Jan 31 + 1 month = Feb 28). */
export function shiftMonths(iso: string, n: number): string {
  return isoOf(addMonths(toDay(iso)!, n, { in: UTC }));
}

export const firstOfMonth = (iso: string): string => isoOf(startOfMonth(toDay(iso)!, { in: UTC }));
export const lastOfMonth = (iso: string): string => isoOf(endOfMonth(toDay(iso)!, { in: UTC }));

/** Plain string compare works for `yyyy-mm-dd`. */
export function clampDay(iso: string, min?: string | null, max?: string | null): string {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

export const inRange = (iso: string, min?: string | null, max?: string | null): boolean =>
  !(min && iso < min) && !(max && iso > max);

/** The 42 days (6 weeks, Sunday first) shown for the month `iso` is in. Always 6 rows, so the popover never jumps. */
export function monthGrid(iso: string, weekStartsOn: 0 | 1 = 0): string[] {
  const start = startOfWeek(startOfMonth(toDay(iso)!, { in: UTC }), { in: UTC, weekStartsOn });
  return Array.from({ length: 42 }, (_, i) => isoOf(addDays(start, i, { in: UTC })));
}

export const sameMonth = (a: string, b: string): boolean => a.slice(0, 7) === b.slice(0, 7);

/**
 * Today in the owner's zone. Without a zone it is the browser's zone, as the native date input it replaced
 * used (and as settings.time_zone is first set from).
 */
export const todayDay = (timeZone?: string, now: Date = new Date()): string =>
  todayIn(now, timeZone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE));

const TYPED_FORMATS = [
  "yyyy-MM-dd",
  "M/d/yyyy",
  "M/d/yy",
  "M-d-yyyy",
  "MMM d, yyyy",
  "MMM d yyyy",
  "MMMM d, yyyy",
  "MMMM d yyyy",
  "d MMM yyyy",
  "d MMMM yyyy",
  "MMM d",
  "MMMM d",
  "d MMM",
  "M/d",
];

/**
 * A typed date, read the way the owner writes it: "Nov 21, 2026", "nov 21", "11/21/2026", "11/21",
 * "2026-11-21", "today", "tomorrow", "yesterday". A day without a year takes the year of `today`.
 * Null when it is not a date.
 */
export function parseTypedDay(text: string, today: string): string | null {
  const t = text.trim().replace(/\s+/g, " ").replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
  if (!t) return null;
  const word = t.toLowerCase();
  if (word === "today") return today;
  if (word === "tomorrow") return shiftDays(today, 1);
  if (word === "yesterday") return shiftDays(today, -1);
  const ref = toDay(today)!;
  for (const f of TYPED_FORMATS) {
    const d = parse(t, f, ref, { in: UTC });
    if (isValid(d) && d.getFullYear() >= 1000 && d.getFullYear() <= 9999) return isoOf(d);
  }
  return null;
}

// ---- Times: `HH:mm` (24 h) values, 12-hour display ----

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isHhmm = (s: string | null | undefined): s is string => !!s && HHMM.test(s);

/** "9:30 PM". */
export function formatTime(hhmm: string | null | undefined): string {
  if (!isHhmm(hhmm)) return "";
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Every time of day in `step`-minute steps: "00:00", "00:05", ... */
export function timeSteps(step = 5): string[] {
  return Array.from({ length: (24 * 60) / step }, (_, i) => {
    const mins = i * step;
    return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  });
}

/**
 * A typed time: "9", "9:30", "930", "9:30pm", "9p", "21:30", "noon", "midnight". Without am/pm, 1 to 6
 * reads as afternoon only when written as "1pm"; plain hours are taken as written (24 h). Null when not a time.
 */
export function parseTypedTime(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, "").replace(/\./g, "");
  if (!t) return null;
  if (t === "noon") return "12:00";
  if (t === "midnight") return "00:00";
  const m = /^(\d{1,2})(?::?(\d{2}))?(a|am|p|pm)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.[0];
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === "p" ? 12 : 0);
  } else if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** The step at or just before `hhmm`, for scrolling the list to it. */
export function nearestStep(hhmm: string, step = 5): string {
  const [h, m] = hhmm.split(":").map(Number);
  const mins = Math.floor((h * 60 + m) / step) * step;
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/** `yyyy-mm-ddTHH:mm` (the datetime-local shape) split into its day and time; parts that are not valid are "". */
export function splitDateTime(v: string | null | undefined): { date: string; time: string } {
  const [date = "", time = ""] = (v ?? "").split("T");
  return { date: isIsoDay(date) ? date : "", time: isHhmm(time.slice(0, 5)) ? time.slice(0, 5) : "" };
}
