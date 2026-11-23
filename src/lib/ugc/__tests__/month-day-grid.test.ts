/**
 * Month-grid slicing for the analytics Posts-by-day / Views-by-day cards.
 *
 * Pinned:
 *  - UTC day keys, Sunday lead pad (same as MonthPostingCalendar)
 *  - a day with posts and 0 views is UNKNOWN, never a painted 0
 *  - a day with no posts is a real 0
 *  - a day missing from the series (outside coverage, including future) is unknown, never a fake 0
 *  - a frozen video with a last positive count stays known
 */
import { describe, it, expect } from "vitest";
import {
  buildMonthGrid,
  defaultMonthKey,
  monthsCoveredBySeries,
  postsSeriesFromCadence,
  viewsSeriesFromBands,
} from "@/lib/ugc/month-day-grid";

const NOW = new Date("2026-08-24T18:00:00.000Z");

describe("postsSeriesFromCadence", () => {
  it("keeps a real zero on a day with no posts", () => {
    const series = postsSeriesFromCadence([
      { date: "2026-08-01", posts: 0 },
      { date: "2026-08-02", posts: 3 },
    ]);
    expect(series[0]).toEqual({ date: "2026-08-01", value: 0 });
    expect(series[1]).toEqual({ date: "2026-08-02", value: 3 });
  });
});

describe("viewsSeriesFromBands", () => {
  it("a day with posts and 0 views is unknown, not a fake 0", () => {
    const series = viewsSeriesFromBands(
      [
        { date: "2026-08-10", posts: 2 },
        { date: "2026-08-11", posts: 0 },
      ],
      [
        { date: "2026-08-10", total: 0 },
        { date: "2026-08-11", total: 0 },
      ],
    );
    expect(series[0]!.value).toBeNull();
    expect(series[1]!.value).toBe(0);
  });

  it("a positive total is a real reading (includes freeze leftovers)", () => {
    const series = viewsSeriesFromBands(
      [{ date: "2026-08-10", posts: 1 }],
      [{ date: "2026-08-10", total: 412 }],
    );
    expect(series[0]!.value).toBe(412);
  });
});

describe("buildMonthGrid", () => {
  it("pads Sunday-start so 2026-08-01 (Saturday) sits in column 6", () => {
    const cells = buildMonthGrid(
      postsSeriesFromCadence([{ date: "2026-08-01", posts: 1 }]),
      "2026-08",
      NOW,
    );
    const first = cells.find((c) => c.dayOfMonth === 1);
    expect(first).toBeDefined();
    expect(cells.indexOf(first!)).toBe(6);
    expect(first!.value).toBe(1);
  });

  it("marks today and keeps unknown values as null", () => {
    const cells = buildMonthGrid(
      [{ date: "2026-08-24", value: null }],
      "2026-08",
      NOW,
    );
    const today = cells.find((c) => c.date === "2026-08-24");
    expect(today?.isToday).toBe(true);
    expect(today?.value).toBeNull();
    const empty = cells.find((c) => c.date === "2026-08-02");
    expect(empty?.value).toBeNull();
  });
});

describe("monthsCoveredBySeries / defaultMonthKey", () => {
  it("lists unique months oldest-first and defaults to the latest not after now", () => {
    const months = monthsCoveredBySeries([
      { date: "2026-07-31" },
      { date: "2026-08-01" },
      { date: "2026-08-24" },
    ]);
    expect(months).toEqual(["2026-07", "2026-08"]);
    expect(defaultMonthKey(months, "2026-08")).toBe("2026-08");
    expect(defaultMonthKey(["2026-09"], "2026-08")).toBe("2026-08");
  });
});
