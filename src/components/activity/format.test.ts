import { expect, test } from "vitest";

import type { ActivityEntry } from "@/lib/activity/types";

import { byDay, dayKey, dayLabel, timeText } from "./format";

const TZ = "America/Los_Angeles";
const NOW = new Date("2026-11-21T20:00:00Z"); // Saturday noon in LA

test("days in the owner's zone, not UTC", () => {
  // 03:00 UTC Nov 21 is still Nov 20 in LA.
  expect(dayKey("2026-11-21T03:00:00Z", TZ)).toBe("2026-11-20");
  expect(dayLabel("2026-11-21", TZ, NOW)).toBe("Today");
  expect(dayLabel("2026-11-20", TZ, NOW)).toBe("Yesterday");
  expect(dayLabel("2026-11-18", TZ, NOW)).toBe("Wednesday, November 18");
  expect(dayLabel("2025-12-31", TZ, NOW)).toBe("Wednesday, December 31, 2025");
  expect(timeText("2026-11-21T20:05:00Z", TZ)).toBe("12:05 PM");
});

test("byDay keeps order and cuts at day changes", () => {
  const e = (id: string, at: string) => ({ id, at }) as ActivityEntry;
  const days = byDay([e("a", "2026-11-21T19:00:00Z"), e("b", "2026-11-21T09:00:00Z"), e("c", "2026-11-21T03:00:00Z")], TZ);
  expect(days.map((d) => [d.key, d.entries.map((x) => x.id)])).toEqual([
    ["2026-11-21", ["a", "b"]],
    ["2026-11-20", ["c"]],
  ]);
});
