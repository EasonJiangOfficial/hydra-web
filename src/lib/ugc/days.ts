/**
 * Calendar days in the owner's time zone (`public.settings.time_zone`).
 *
 * A day is a "YYYY-MM-DD" key. An instant maps to the key of its wall-clock
 * date in `zone`; a key maps back to the instant of local midnight. Key
 * arithmetic (next day, month length) is pure calendar math, so it never drifts
 * across DST. Every function takes the zone explicitly; tests inject it.
 */
import { TZDate } from "@date-fns/tz";

export const DAY_KEY_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const MONTH_KEY_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The zone of the machine running the code (tests and the browser default). */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** True when `zone` is an IANA zone this runtime knows. */
export function isValidZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The owner's zone, falling back to UTC when the setting is empty or unknown. */
export function ownerZone(setting: string | null | undefined): string {
  return isValidZone(setting) ? setting : "UTC";
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** "YYYY-MM-DD" of `at`'s wall-clock date in `zone`. */
export function dayKeyInZone(at: Date, zone: string): string {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(zone, f);
  }
  const parts = f.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "YYYY-MM" of `at` in `zone`. */
export function monthKeyInZone(at: Date, zone: string): string {
  return dayKeyInZone(at, zone).slice(0, 7);
}

function parts(key: string): [number, number, number] {
  const [y, m, d] = key.split("-").map(Number);
  return [y, m, d ?? 1];
}

/** The instant of local midnight that starts `dayKey` in `zone`. */
export function zonedDayStart(dayKey: string, zone: string): Date {
  const [y, m, d] = parts(dayKey);
  return new Date(new TZDate(y, m - 1, d, zone).getTime());
}

/** `dayKey` shifted by `delta` calendar days. */
export function addDays(dayKey: string, delta: number): string {
  const [y, m, d] = parts(dayKey);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** Calendar days in a "YYYY-MM" month (leap years included). */
export function daysInMonth(month: string): number {
  const [y, m] = parts(month);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The "YYYY-MM" month after `month`. */
export function nextMonth(month: string): string {
  const [y, m] = parts(month);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

/** Every day key of a "YYYY-MM" month, in order. */
export function monthDayKeys(month: string): string[] {
  const n = daysInMonth(month);
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/** Inclusive instants of a month in `zone`: local midnight of the 1st to 1 ms before the next month. */
export function zonedMonthRange(month: string, zone: string): { start: Date; end: Date } {
  const start = zonedDayStart(`${month}-01`, zone);
  const end = new Date(zonedDayStart(`${nextMonth(month)}-01`, zone).getTime() - 1);
  return { start, end };
}

/** Every day key from `from` to `to`, both included. Empty when `to` < `from`. */
export function dayKeysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let k = from; k <= to; k = addDays(k, 1)) out.push(k);
  return out;
}
