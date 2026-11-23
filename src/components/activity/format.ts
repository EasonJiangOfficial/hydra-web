import type { ActivityActor, ActivityEntry } from "@/lib/activity/types";

export const WHO: Record<ActivityActor, string> = { you: "You", hydra: "Hydra", routine: "Routine" };

/** Why an entry cannot be undone, for the hover behind its info dot. */
export const WHY_NOT: Record<NonNullable<ActivityEntry["cannotUndo"]>, string> = {
  expired: "Older than 30 days. Deleted items are gone for good.",
  undone: "Already undone.",
  outside: "It acted outside Hydra, like a sent email or a payment.",
};

const dayFmt = new Map<string, Intl.DateTimeFormat>();
/** YYYY-MM-DD of a moment in the owner's zone. */
export function dayKey(at: string | Date, tz: string): string {
  let f = dayFmt.get(tz);
  if (!f) dayFmt.set(tz, (f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })));
  return f.format(new Date(at));
}

/** "Today", "Yesterday", "Friday, November 20" (with the year when it is not this year). */
export function dayLabel(key: string, tz: string, now: Date): string {
  if (key === dayKey(now, tz)) return "Today";
  if (key === dayKey(new Date(now.getTime() - 86_400_000), tz)) return "Yesterday";
  const [y, m, d] = key.split("-").map(Number);
  const sameYear = key.slice(0, 4) === dayKey(now, tz).slice(0, 4);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "3:42 PM" in the owner's zone. */
export const timeText = (at: string, tz: string) =>
  new Date(at).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });

/** Entries newest first, cut into days. */
export function byDay(entries: ActivityEntry[], tz: string): { key: string; entries: ActivityEntry[] }[] {
  const days: { key: string; entries: ActivityEntry[] }[] = [];
  for (const e of entries) {
    const key = dayKey(e.at, tz);
    const last = days.at(-1);
    if (last?.key === key) last.entries.push(e);
    else days.push({ key, entries: [e] });
  }
  return days;
}
