/**
 * Owner-zone day math, and the ported calendar helpers run in a real zone:
 * month ends, leap years and both DST changes, with injected `now` and zone.
 */
import { describe, it, expect } from "vitest";
import {
  addDays,
  dayKeyInZone,
  daysInMonth,
  dayKeysBetween,
  monthDayKeys,
  ownerZone,
  zonedDayStart,
  zonedMonthRange,
} from "@/lib/ugc/days";
import { buildConsistencyResponse } from "@/lib/ugc/posting-consistency";
import { buildCadence } from "@/lib/ugc/creator-cadence";
import { buildMonthCalendar } from "@/lib/ugc/posting-calendar";
import { buildMonthGrid } from "@/lib/ugc/month-day-grid";
import { buildEarningsCalendar } from "@/lib/ugc/earnings-calendar";

const NY = "America/New_York";
const HOUR = 3_600_000;

describe("dayKeyInZone", () => {
  it.each([
    { iso: "2026-03-01T04:59:59Z", zone: NY, day: "2026-02-28" },
    { iso: "2026-03-01T05:00:00Z", zone: NY, day: "2026-03-01" },
    { iso: "2026-12-31T23:30:00Z", zone: "Asia/Tokyo", day: "2027-01-01" },
    { iso: "2027-01-01T00:30:00Z", zone: "America/Los_Angeles", day: "2026-12-31" },
    { iso: "2028-02-29T12:00:00Z", zone: "UTC", day: "2028-02-29" },
  ])("$iso in $zone is $day", ({ iso, zone, day }) => expect(dayKeyInZone(new Date(iso), zone)).toBe(day));
});

describe("zoned day and month bounds", () => {
  it("the spring-forward day is 23 hours, the fall-back day 25", () => {
    const len = (day: string) => zonedDayStart(addDays(day, 1), NY).getTime() - zonedDayStart(day, NY).getTime();
    expect(len("2026-03-08")).toBe(23 * HOUR);
    expect(len("2026-11-01")).toBe(25 * HOUR);
    expect(len("2026-11-02")).toBe(24 * HOUR);
  });

  it("a month runs from local midnight to 1 ms before the next", () => {
    const { start, end } = zonedMonthRange("2026-11", NY);
    expect(start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(end.toISOString()).toBe("2026-12-01T04:59:59.999Z");
  });

  it.each([
    { month: "2026-02", n: 28 },
    { month: "2028-02", n: 29 },
    { month: "2100-02", n: 28 },
    { month: "2026-12", n: 31 },
  ])("$month has $n days", ({ month, n }) => {
    expect(daysInMonth(month)).toBe(n);
    expect(monthDayKeys(month)).toHaveLength(n);
  });

  it("day arithmetic crosses month, year and leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(dayKeysBetween("2026-12-30", "2027-01-02")).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
    expect(dayKeysBetween("2026-01-02", "2026-01-01")).toEqual([]);
  });

  it("an unset or unknown zone falls back to UTC", () => {
    expect(ownerZone(null)).toBe("UTC");
    expect(ownerZone("Mars/Base")).toBe("UTC");
    expect(ownerZone(NY)).toBe(NY);
  });
});

describe("ported calendar helpers in the owner's zone", () => {
  const lateMarch31 = new Date("2026-04-01T03:30:00Z"); // 23:30 EDT, Mar 31

  it("posting consistency buckets by local day and anchors streaks on the local today", () => {
    const since = zonedDayStart("2026-03-25", NY);
    const now = new Date("2026-04-01T03:45:00Z"); // still Mar 31 in New York
    const r = buildConsistencyResponse(
      [
        { postedAt: lateMarch31, platform: "TIKTOK" },
        { postedAt: new Date("2026-03-30T16:00:00Z"), platform: "TIKTOK" },
      ],
      since,
      now,
      7,
      NY,
    );
    expect(r.days.map((d) => d.date)).toEqual(dayKeysBetween("2026-03-25", "2026-03-31"));
    expect(r.days.at(-1)).toEqual({ date: "2026-03-31", count: 1 });
    expect(r.currentStreak).toBe(2);
  });

  it("cadence and the month calendar keep a late-night post in its local month", () => {
    const month = buildMonthCalendar([{ postedAt: lateMarch31 }], "2026-03", NY);
    expect(month.days).toHaveLength(31);
    expect(month.days.at(-1)).toEqual({ date: "2026-03-31", count: 1 });
    expect(buildMonthCalendar([{ postedAt: lateMarch31 }], "2026-04", NY).stats.totalPosts).toBe(0);
    // Ripple's UTC default still puts it in April.
    expect(buildMonthCalendar([{ postedAt: lateMarch31 }], "2026-04").stats.totalPosts).toBe(1);
  });

  it("cadence across the fall-back day has one cell per calendar day", () => {
    const c = buildCadence([], zonedDayStart("2026-10-31", NY), zonedDayStart("2026-11-02", NY), NY);
    expect(c.days.map((d) => d.date)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
  });

  it("the month grid marks today in the owner's zone", () => {
    const cells = buildMonthGrid([], "2026-03", lateMarch31, NY);
    expect(cells.find((c) => c.isToday)?.date).toBe("2026-03-31");
    expect(buildMonthGrid([], "2026-03", lateMarch31).find((c) => c.isToday)).toBeUndefined();
  });

  it("the earnings calendar puts money on the local day", () => {
    const model = buildEarningsCalendar({
      month: "2026-03",
      zone: NY,
      now: lateMarch31,
      rows: [
        {
          postedAt: lateMarch31.toISOString(),
          campaignId: "deal-1",
          campaignName: "Glow",
          description: "",
          totalViews: 100,
          basePay: 25,
          cpm: 0,
          bonus: 0,
          totalEarned: 25,
          tier: null,
          excluded: false,
        },
      ],
      lines: [],
      missed: new Map([["2026-03-30", { missed: 1, amount: 25 }]]),
    });
    const last = model.days.at(-1)!;
    expect(last).toMatchObject({ date: "2026-03-31", earnings: 25, isToday: true });
    expect(model.days.find((d) => d.date === "2026-03-30")?.lost).toEqual({ missed: 1, amount: 25 });
  });
});
