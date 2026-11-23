import { describe, expect, it } from "vitest";

import {
  clampDay,
  formatDay,
  formatTime,
  inRange,
  monthGrid,
  nearestStep,
  parseTypedDay,
  parseTypedTime,
  shiftDays,
  shiftMonths,
  splitDateTime,
  timeSteps,
  toDay,
  todayDay,
} from "./date-input";

const TZ = "America/Toronto";

describe("days in the owner's zone", () => {
  it("today follows the owner's zone, not UTC", () => {
    // 2026-11-22 02:30 UTC is still Nov 21 evening in Toronto.
    expect(todayDay(TZ, new Date("2026-11-22T02:30:00Z"))).toBe("2026-11-21");
    expect(todayDay("UTC", new Date("2026-11-22T02:30:00Z"))).toBe("2026-11-22");
    expect(todayDay("Asia/Tokyo", new Date("2026-11-21T16:00:00Z"))).toBe("2026-11-22");
  });

  it("DST days: the spring-forward and fall-back days are one day each", () => {
    // Toronto: 2026-03-08 loses an hour, 2026-11-01 gains one.
    expect(todayDay(TZ, new Date("2026-03-08T04:59:00Z"))).toBe("2026-03-07");
    expect(todayDay(TZ, new Date("2026-03-08T05:00:00Z"))).toBe("2026-03-08");
    expect(todayDay(TZ, new Date("2026-03-09T03:59:00Z"))).toBe("2026-03-08");
    expect(todayDay(TZ, new Date("2026-11-01T03:59:00Z"))).toBe("2026-10-31");
    expect(todayDay(TZ, new Date("2026-11-01T04:00:00Z"))).toBe("2026-11-01");
    expect(todayDay(TZ, new Date("2026-11-02T04:59:00Z"))).toBe("2026-11-01");
    expect(shiftDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(shiftDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDays("2026-11-01", 1)).toBe("2026-11-02");
  });

  it("month grids hold each day once, in order, across DST months", () => {
    for (const month of ["2026-03-01", "2026-11-01", "2024-02-01", "2026-12-01"]) {
      const grid = monthGrid(month);
      expect(grid).toHaveLength(42);
      expect(new Set(grid).size).toBe(42);
      for (let i = 1; i < grid.length; i++) expect(shiftDays(grid[i - 1], 1)).toBe(grid[i]);
      expect(toDay(grid[0])!.getDay()).toBe(0); // Sunday first
    }
    expect(monthGrid("2026-11-15")[0]).toBe("2026-11-01"); // Nov 1 2026 is a Sunday
    expect(monthGrid("2026-03-15").filter((d) => d.startsWith("2026-03"))).toHaveLength(31);
    expect(monthGrid("2024-02-10").filter((d) => d.startsWith("2024-02"))).toHaveLength(29);
    // Monday first: Nov 2026 opens on Mon Oct 26, so Sun Nov 1 ends the first row.
    expect(monthGrid("2026-11-15", 1)[0]).toBe("2026-10-26");
    expect(monthGrid("2026-11-15", 1)[6]).toBe("2026-11-01");
    expect(toDay(monthGrid("2026-03-15", 1)[0])!.getDay()).toBe(1);
  });

  it("month boundaries: Jan 31 + 1 month is Feb's last day; year rolls over", () => {
    expect(shiftMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(shiftMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(shiftMonths("2026-01-15", -1)).toBe("2025-12-15");
    expect(shiftDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("min and max", () => {
    expect(clampDay("2026-11-01", "2026-11-05", "2026-11-20")).toBe("2026-11-05");
    expect(clampDay("2026-11-30", "2026-11-05", "2026-11-20")).toBe("2026-11-20");
    expect(clampDay("2026-11-10", "2026-11-05", "2026-11-20")).toBe("2026-11-10");
    expect(inRange("2026-11-04", "2026-11-05")).toBe(false);
    expect(inRange("2026-11-05", "2026-11-05", "2026-11-05")).toBe(true);
    expect(inRange("2026-11-21", undefined, "2026-11-20")).toBe(false);
  });

  it("formats in the owner's style and rejects days that do not exist", () => {
    expect(formatDay("2026-11-21")).toBe("Nov 21, 2026");
    expect(formatDay("2026-03-08")).toBe("Mar 8, 2026");
    expect(formatDay("")).toBe("");
    expect(toDay("2026-02-30")).toBeNull();
    expect(toDay("2026-13-01")).toBeNull();
    expect(toDay("nope")).toBeNull();
  });
});

describe("typing a date", () => {
  const today = "2026-11-21";
  it.each([
    ["Nov 21, 2026", "2026-11-21"],
    ["nov 21 2026", "2026-11-21"],
    ["November 3, 2027", "2027-11-03"],
    ["Nov 21st", "2026-11-21"],
    ["dec 1", "2026-12-01"],
    ["21 Nov 2026", "2026-11-21"],
    ["11/21/2026", "2026-11-21"],
    ["11/21/26", "2026-11-21"],
    ["3/8", "2026-03-08"],
    ["2026-03-08", "2026-03-08"],
    ["  2026-11-01 ", "2026-11-01"],
    ["today", "2026-11-21"],
    ["Tomorrow", "2026-11-22"],
    ["yesterday", "2026-11-20"],
  ])("%s -> %s", (text, iso) => {
    expect(parseTypedDay(text, today)).toBe(iso);
  });
  it.each(["", "soon", "2/30/2026", "13/1/2026", "2026-02-30", "Nov 32"])("%s is not a date", (text) => {
    expect(parseTypedDay(text, today)).toBeNull();
  });
});

describe("times", () => {
  it.each([
    ["9", "09:00"],
    ["9:30", "09:30"],
    ["930", "09:30"],
    ["9:30pm", "21:30"],
    ["9:30 PM", "21:30"],
    ["9p", "21:00"],
    ["12am", "00:00"],
    ["12pm", "12:00"],
    ["12:05 a.m.", "00:05"],
    ["21:30", "21:30"],
    ["0000", "00:00"],
    ["noon", "12:00"],
  ])("%s -> %s", (text, hhmm) => {
    expect(parseTypedTime(text)).toBe(hhmm);
  });
  it.each(["", "25:00", "9:60", "13pm", "0am", "lunch"])("%s is not a time", (text) => {
    expect(parseTypedTime(text)).toBeNull();
  });
  it("shows 12-hour times and lists 5-minute steps", () => {
    expect(formatTime("00:00")).toBe("12:00 AM");
    expect(formatTime("12:30")).toBe("12:30 PM");
    expect(formatTime("21:05")).toBe("9:05 PM");
    expect(formatTime("bad")).toBe("");
    const steps = timeSteps(5);
    expect(steps).toHaveLength(288);
    expect(steps[0]).toBe("00:00");
    expect(steps[1]).toBe("00:05");
    expect(steps.at(-1)).toBe("23:55");
    expect(nearestStep("09:33")).toBe("09:30");
  });
  it("splits datetime-local values", () => {
    expect(splitDateTime("2026-11-22T09:00")).toEqual({ date: "2026-11-22", time: "09:00" });
    expect(splitDateTime("2026-11-22T09:00:00")).toEqual({ date: "2026-11-22", time: "09:00" });
    expect(splitDateTime("")).toEqual({ date: "", time: "" });
  });
});
