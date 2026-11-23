import type { Delivery, GateReason, RoutineInput, RoutineTool, RunStatus } from "./types";

export const TOOLS: readonly { value: RoutineTool; label: string }[] = [
  { value: "hydra", label: "Hydra data" },
  { value: "mac", label: "Mac" },
  { value: "gmail", label: "Gmail" },
  { value: "calendar", label: "Google Calendar" },
];

export const DELIVERIES: readonly { value: Delivery; label: string }[] = [
  { value: "spoken", label: "Spoken on the Mac" },
  { value: "notification", label: "Notification" },
  { value: "push", label: "Phone push" },
  { value: "email", label: "Email to self" },
];

export const STATUS_LABEL: Record<RunStatus, string> = {
  ok: "Ok",
  waiting_approval: "Waiting for approval",
  waiting_mac: "Waiting for the Mac",
  failed: "Failed",
  skipped: "Skipped, the Mac was off",
  running: "Running",
  queued: "Queued",
};

export const REASON_LABEL: Record<GateReason, string> = {
  delete: "Delete",
  bulk: "Many rows",
  send: "Send",
  pay: "Pay",
  mac: "On the Mac",
};

export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const BLANK_INPUT: RoutineInput = {
  name: "",
  instruction: "",
  schedule: { kind: "daily", time: "08:00" },
  tools: ["hydra"],
  delivery: ["notification"],
  whenMacOff: "wait",
};

export const toggle = <T,>(list: readonly T[], value: T): T[] => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

/** The name when the owner left it blank: the instruction's first words. */
export function nameFrom(name: string, instruction: string): string {
  const typed = name.trim();
  if (typed) return typed.slice(0, 120);
  const words = instruction.trim().replace(/\s+/g, " ");
  return words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words;
}

const formats = new Map<string, Intl.DateTimeFormat>();
function localParts(date: Date, tz: string) {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formats.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), time: `${p.hour}:${p.minute}` };
}

/**
 * A moment in the owner's time zone, in words: "Today 08:00", "Tomorrow 08:00", "Yesterday 22:00",
 * else "Mon, Nov 23 08:00". 24-hour, like the schedule text.
 */
export function whenText(iso: string, tz: string, nowIso: string): string {
  const at = new Date(iso);
  const here = localParts(at, tz);
  const now = localParts(new Date(nowIso), tz);
  const days = Math.round((Date.UTC(here.y, here.m - 1, here.d) - Date.UTC(now.y, now.m - 1, now.d)) / 86_400_000);
  if (days === 0) return `Today ${here.time}`;
  if (days === 1) return `Tomorrow ${here.time}`;
  if (days === -1) return `Yesterday ${here.time}`;
  const date = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(at);
  return `${date} ${here.time}`;
}
