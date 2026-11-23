import { describe, expect, it } from "vitest";

import { shiftAlertForCopy, dueAlerts, dueEventAlerts, dueTaskAlerts } from "./alerts";
import {
  addDays,
  dayOf,
  daysUntil,
  deadlineLabel,
  dueTone,
  formatDay,
  formatStamp,
  fromLocalInput,
  monthBounds,
  todayIn,
  toLocalInput,
  wallClock,
  zonedInstant,
} from "./dates";
import { moveEventToDay, occurrencesBetween } from "./events";
import { dueRepeatDates, nextRepeatDate } from "./repeat";
import type { PlanningEvent, PlanningStatus, PlanningTask } from "./types";

const TZ = "America/Toronto";
const iso = (d: Date): string => d.toISOString();

describe("dates in the owner's zone", () => {
  it("todayIn follows the zone, not the machine", () => {
    // 03:30 UTC on the 22nd is 22:30 on the 21st in Toronto, 12:30 on the 22nd in Tokyo.
    const now = new Date("2026-11-22T03:30:00Z");
    expect(todayIn(now, TZ)).toBe("2026-11-21");
    expect(todayIn(now, "Asia/Tokyo")).toBe("2026-11-22");
  });

  it("keeps 09:00 across the fall DST change (Nov 1, 2026)", () => {
    expect(iso(zonedInstant("2026-10-31", "09:00", TZ))).toBe("2026-10-31T13:00:00.000Z"); // EDT
    expect(iso(zonedInstant("2026-11-02", "09:00", TZ))).toBe("2026-11-02T14:00:00.000Z"); // EST
  });

  it("keeps 09:00 across the spring DST change (Mar 8, 2026)", () => {
    expect(iso(zonedInstant("2026-03-07", "09:00", TZ))).toBe("2026-03-07T14:00:00.000Z");
    expect(iso(zonedInstant("2026-03-09", "09:00", TZ))).toBe("2026-03-09T13:00:00.000Z");
  });

  it("wallClock and zonedInstant round-trip", () => {
    const at = zonedInstant("2026-12-31", "23:45", TZ);
    expect(wallClock(at, TZ)).toEqual({ date: "2026-12-31", time: "23:45" });
    expect(dayOf("2027-01-01T04:59:00Z", TZ)).toBe("2026-12-31");
  });

  it("adds days across month and year ends and bounds a leap February", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(monthBounds("2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthBounds("2026-11-21")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(daysUntil("2026-12-01", "2026-11-21")).toBe(10);
  });

  it("labels due dates and deadlines", () => {
    expect(dueTone("2026-11-20", "2026-11-21")).toBe("overdue");
    expect(dueTone("2026-11-21", "2026-11-21")).toBe("today");
    expect(dueTone(null, "2026-11-21")).toBeNull();
    expect(deadlineLabel("2026-11-24", "2026-11-21", false)).toEqual({ text: "3 days left", tone: "upcoming" });
    expect(deadlineLabel("2026-11-20", "2026-11-21", false).text).toBe("1 day overdue");
    expect(formatDay("2026-11-24", "2026-11-21")).toBe("Nov 24");
    expect(formatDay("2027-01-02", "2026-11-21")).toBe("Jan 2, 2027");
  });

  it("converts a datetime-local value both ways", () => {
    const instant = fromLocalInput("2026-11-24T09:00", TZ);
    expect(instant).toBe("2026-11-24T14:00:00.000Z");
    expect(toLocalInput(instant, TZ)).toBe("2026-11-24T09:00");
    expect(fromLocalInput("", TZ)).toBeNull();
    expect(toLocalInput(null, TZ)).toBe("");
    expect(formatStamp("2026-11-24T14:00:00.000Z", TZ, "2026-11-21")).toBe("Nov 24, 9:00 AM");
  });
});

describe("repeat dates", () => {
  it("monthly keeps the series day: Jan 31, Feb 28, Mar 31", () => {
    expect(nextRepeatDate("2026-01-31", "monthly", 31)).toBe("2026-02-28");
    expect(nextRepeatDate("2026-02-28", "monthly", 31)).toBe("2026-03-31");
    expect(nextRepeatDate("2028-01-31", "monthly", 31)).toBe("2028-02-29");
    expect(nextRepeatDate("2026-12-15", "monthly", 15)).toBe("2027-01-15");
  });

  it("weekdays skip the weekend", () => {
    expect(nextRepeatDate("2026-11-20", "weekdays", 20)).toBe("2026-11-23"); // Fri -> Mon
    expect(nextRepeatDate("2026-11-23", "weekdays", 23)).toBe("2026-11-24");
    expect(nextRepeatDate("2026-11-21", "daily", 21)).toBe("2026-11-22");
    expect(nextRepeatDate("2026-12-28", "weekly", 28)).toBe("2027-01-04");
  });

  it("dueRepeatDates stops at the cap and skips days before the repeat turned on", () => {
    expect(dueRepeatDates("2026-11-01", "daily", 1, "2026-11-10", 3)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(dueRepeatDates("2026-11-01", "daily", 1, "2026-11-05", 10, "2026-11-04")).toEqual(["2026-11-04", "2026-11-05"]);
    expect(dueRepeatDates("2026-11-05", "weekly", 5, "2026-11-11", 10)).toEqual([]);
  });
});

const event = (over: Partial<PlanningEvent>): PlanningEvent => ({
  id: "e1",
  title: "Standup",
  startsAt: "2026-11-23T15:00:00.000Z",
  endsAt: null,
  allDay: false,
  category: null,
  repeat: null,
  notes: "",
  alertAt: null,
  googleEventId: null,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  ...over,
});

describe("event occurrences", () => {
  it("a one-off event shows once, only inside the range", () => {
    const e = event({});
    expect(occurrencesBetween(e, "2026-11-01", "2026-11-30", TZ).map((o) => o.date)).toEqual(["2026-11-23"]);
    expect(occurrencesBetween(e, "2026-12-01", "2026-12-31", TZ)).toEqual([]);
  });

  it("a weekly event keeps its wall clock time across DST", () => {
    // Sat Oct 31 09:00 EDT = 13:00Z; Nov 7 and 14 are 09:00 EST = 14:00Z.
    const e = event({ startsAt: "2026-10-31T13:00:00.000Z", repeat: "weekly" });
    const got = occurrencesBetween(e, "2026-10-31", "2026-11-14", TZ);
    expect(got.map((o) => o.date)).toEqual(["2026-10-31", "2026-11-07", "2026-11-14"]);
    expect(got.map((o) => o.startsAt)).toEqual([
      "2026-10-31T13:00:00.000Z",
      "2026-11-07T14:00:00.000Z",
      "2026-11-14T14:00:00.000Z",
    ]);
  });

  it("a monthly event on the 31st clamps to short months", () => {
    const e = event({ startsAt: "2026-01-31T15:00:00.000Z", repeat: "monthly" });
    expect(occurrencesBetween(e, "2026-01-01", "2026-04-30", TZ).map((o) => o.date)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("keeps the length and skips weekends for weekdays", () => {
    const e = event({ startsAt: "2026-11-20T15:00:00.000Z", endsAt: "2026-11-20T16:30:00.000Z", repeat: "weekdays" });
    const got = occurrencesBetween(e, "2026-11-20", "2026-11-24", TZ);
    expect(got.map((o) => o.date)).toEqual(["2026-11-20", "2026-11-23", "2026-11-24"]);
    expect(got[1].endsAt).toBe("2026-11-23T16:30:00.000Z");
  });

  it("moving an event to another day keeps time, length and alert lead", () => {
    const moved = moveEventToDay(
      { startsAt: "2026-11-23T15:00:00.000Z", endsAt: "2026-11-23T16:00:00.000Z", alertAt: "2026-11-23T14:50:00.000Z" },
      "2026-11-25",
      TZ,
    );
    expect(moved).toEqual({
      startsAt: "2026-11-25T15:00:00.000Z",
      endsAt: "2026-11-25T16:00:00.000Z",
      alertAt: "2026-11-25T14:50:00.000Z",
    });
  });
});

const status = (id: string, isDone: boolean): PlanningStatus => ({ id, label: id, color: "#000000", position: 0, isDone });
const task = (over: Partial<PlanningTask>): PlanningTask => ({
  id: "t1",
  title: "Send W-9",
  notes: "",
  statusId: "todo",
  goalId: null,
  category: null,
  dueDate: "2026-11-24",
  position: 1,
  alertAt: "2026-11-24T14:00:00.000Z",
  repeatRule: null,
  repeatSeriesId: null,
  createdAt: "",
  updatedAt: "",
  completedAt: null,
  values: {},
  ...over,
});

describe("alerts", () => {
  const statuses = [status("todo", false), status("done", true)];

  it("a task alert is due inside the window, once past its time", () => {
    const at = new Date("2026-11-24T14:05:00Z");
    expect(dueTaskAlerts([task({})], statuses, at, TZ)).toEqual([
      { kind: "task", itemId: "t1", occurrenceOn: "2026-11-24", alertAt: "2026-11-24T14:00:00.000Z", title: "Send W-9" },
    ]);
    expect(dueTaskAlerts([task({})], statuses, new Date("2026-11-24T13:59:00Z"), TZ)).toEqual([]);
  });

  it("skips old alerts, done tasks and tasks with no alert", () => {
    expect(dueTaskAlerts([task({})], statuses, new Date("2026-11-24T20:05:00Z"), TZ)).toEqual([]);
    expect(dueTaskAlerts([task({ statusId: "done" })], statuses, new Date("2026-11-24T14:05:00Z"), TZ)).toEqual([]);
    expect(dueTaskAlerts([task({ alertAt: null })], statuses, new Date("2026-11-24T14:05:00Z"), TZ)).toEqual([]);
  });

  it("an undated task is keyed on the day of its alert", () => {
    const got = dueTaskAlerts([task({ dueDate: null })], statuses, new Date("2026-11-24T14:05:00Z"), TZ);
    expect(got[0].occurrenceOn).toBe("2026-11-24");
  });

  it("a task's key stays the alert's day when a due date is added or cleared (no second send)", () => {
    const now = new Date("2026-11-24T14:05:00Z");
    const keys = [null, "2026-11-27", "2026-11-20"].map(
      (dueDate) => dueTaskAlerts([task({ dueDate })], statuses, now, TZ)[0].occurrenceOn,
    );
    expect(keys).toEqual(["2026-11-24", "2026-11-24", "2026-11-24"]);
  });

  it("a repeating event alerts each occurrence with the same lead time", () => {
    const e = event({ repeat: "weekdays", alertAt: "2026-11-23T14:50:00.000Z" });
    const now = new Date("2026-11-24T14:55:00Z");
    expect(dueEventAlerts([e], now, TZ)).toEqual([
      { kind: "event", itemId: "e1", occurrenceOn: "2026-11-24", alertAt: "2026-11-24T14:50:00.000Z", title: "Standup" },
    ]);
  });

  it("the lead time survives the DST change", () => {
    // Fri Oct 30 09:00 EDT, 10 minutes before; Mon Nov 2 is 09:00 EST = 14:00Z, so the alert is 13:50Z.
    const e = event({ startsAt: "2026-10-30T13:00:00.000Z", repeat: "weekdays", alertAt: "2026-10-30T12:50:00.000Z" });
    const got = dueEventAlerts([e], new Date("2026-11-02T13:55:00Z"), TZ);
    expect(got.map((g) => [g.occurrenceOn, g.alertAt])).toEqual([["2026-11-02", "2026-11-02T13:50:00.000Z"]]);
  });

  it("dueAlerts merges tasks and events, oldest first", () => {
    const e = event({ alertAt: "2026-11-23T14:59:00.000Z", startsAt: "2026-11-23T15:00:00.000Z" });
    const t = task({ alertAt: "2026-11-23T14:30:00.000Z", dueDate: "2026-11-23" });
    const got = dueAlerts({ tasks: [t], statuses, events: [e] }, new Date("2026-11-23T15:00:00Z"), TZ);
    expect(got.map((g) => g.kind)).toEqual(["task", "event"]);
  });

  it("a repeat copy keeps the alert's wall clock time and its distance from the due date", () => {
    // Alert 09:00 EDT the day before a Saturday due date; the next copy is due Tue Nov 3 (EST).
    expect(shiftAlertForCopy("2026-10-30T13:00:00.000Z", "2026-10-31", "2026-11-03", TZ)).toBe("2026-11-02T14:00:00.000Z");
    expect(shiftAlertForCopy("2026-11-24T14:00:00.000Z", "2026-11-24", "2026-12-01", TZ)).toBe("2026-12-01T14:00:00.000Z");
  });
});
