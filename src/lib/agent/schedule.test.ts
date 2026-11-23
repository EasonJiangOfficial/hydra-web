import { describe, expect, it } from "vitest";
import { describeSchedule, nextRun, scheduleSchema } from "./schedule";

const TZ = "America/Toronto";
const at = (iso: string) => new Date(iso);

describe("routine schedules in the owner's time zone", () => {
  it("runs daily at the wall clock time, today if still ahead, else tomorrow", () => {
    const s = { kind: "daily", time: "08:00" } as const;
    expect(nextRun(s, at("2026-11-21T12:00:00Z"), TZ).toISOString()).toBe("2026-11-21T13:00:00.000Z"); // 07:00 EST: today
    expect(nextRun(s, at("2026-11-21T14:00:00Z"), TZ).toISOString()).toBe("2026-11-22T13:00:00.000Z"); // 09:00 EST: tomorrow
    // Exactly at the run time: the next one is tomorrow (strictly after).
    expect(nextRun(s, at("2026-11-21T13:00:00Z"), TZ).toISOString()).toBe("2026-11-22T13:00:00.000Z");
  });

  it("keeps 08:00 at 08:00 across the spring-forward and fall-back changes", () => {
    const s = { kind: "daily", time: "08:00" } as const;
    // 2026-03-08 is the spring-forward day in Toronto: 08:00 EDT = 12:00 UTC.
    expect(nextRun(s, at("2026-03-07T14:00:00Z"), TZ).toISOString()).toBe("2026-03-08T12:00:00.000Z");
    expect(nextRun(s, at("2026-03-08T12:00:00Z"), TZ).toISOString()).toBe("2026-03-09T12:00:00.000Z");
    // 2026-11-01 is the fall-back day: 08:00 EST = 13:00 UTC.
    expect(nextRun(s, at("2026-10-31T13:00:00Z"), TZ).toISOString()).toBe("2026-11-01T13:00:00.000Z");
  });

  it("runs a time that does not exist on spring-forward day once, just after the jump", () => {
    const s = { kind: "daily", time: "02:30" } as const;
    const run = nextRun(s, at("2026-03-08T05:00:00Z"), TZ); // 00:00 EST on the change day
    expect(run > at("2026-03-08T05:00:00Z")).toBe(true);
    expect(run < at("2026-03-08T12:00:00Z")).toBe(true); // that same morning, not skipped to the 9th
    // The repeated hour on fall-back day runs once.
    const fallBack = { kind: "daily", time: "01:30" } as const;
    const first = nextRun(fallBack, at("2026-11-01T04:00:00Z"), TZ);
    const second = nextRun(fallBack, first, TZ);
    expect(second.getTime() - first.getTime()).toBeGreaterThan(20 * 3_600_000);
  });

  it("skips weekends for weekdays and picks the listed days for weekly", () => {
    const fridayEvening = at("2026-11-20T23:00:00Z"); // Friday 18:00
    expect(nextRun({ kind: "weekdays", time: "09:00" }, fridayEvening, TZ).toISOString()).toBe("2026-11-23T14:00:00.000Z"); // Monday
    const weekly = { kind: "weekly" as const, time: "09:00", days: [1, 4] }; // Monday and Thursday
    expect(nextRun(weekly, at("2026-11-23T15:00:00Z"), TZ).toISOString()).toBe("2026-11-26T14:00:00.000Z"); // Thursday
  });

  it("runs monthly on the last day when the month is shorter", () => {
    const s = { kind: "monthly", time: "07:00", day: 31 } as const;
    expect(nextRun(s, at("2026-01-31T13:00:00Z"), TZ).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(nextRun(s, at("2026-02-28T13:00:00Z"), TZ).toISOString()).toBe("2026-03-31T11:00:00.000Z"); // EDT now
    expect(nextRun(s, at("2026-03-31T12:00:00Z"), TZ).toISOString()).toBe("2026-04-30T11:00:00.000Z");
    expect(nextRun({ kind: "monthly", time: "07:00", day: 29 }, at("2028-02-01T00:00:00Z"), TZ).toISOString()).toBe("2028-02-29T12:00:00.000Z"); // leap year
  });

  it("reads in another zone too, and says itself in plain words", () => {
    expect(nextRun({ kind: "daily", time: "08:00" }, at("2026-11-21T00:00:00Z"), "Asia/Tokyo").toISOString()).toBe("2026-11-21T23:00:00.000Z");
    expect(describeSchedule({ kind: "weekly", time: "09:00", days: [4, 1] })).toBe("Every Monday, Thursday at 09:00");
    expect(describeSchedule({ kind: "weekdays", time: "08:00" })).toBe("Weekdays at 08:00");
  });

  it("refuses a bad schedule", () => {
    expect(scheduleSchema.safeParse({ kind: "daily", time: "25:00" }).success).toBe(false);
    expect(scheduleSchema.safeParse({ kind: "weekly", time: "08:00", days: [] }).success).toBe(false);
    expect(scheduleSchema.safeParse({ kind: "monthly", time: "08:00", day: 32 }).success).toBe(false);
    expect(scheduleSchema.safeParse({ kind: "hourly", time: "08:00" }).success).toBe(false);
  });
});
