import { describe, expect, it } from "vitest";

import { id } from "./fixtures";
import { extendRepeatSeries } from "./repeats";
import { fakeDb, type Call } from "./test-db";

const TZ = "America/Toronto";

function setup(series: object[], latest: object[], copyReply: (call: Call) => unknown = () => id(900)) {
  return fakeDb((c) => {
    if (c.rpc === "planning_repeat_series") return { data: series };
    if (c.table === "planning_tasks") return { data: latest };
    if (c.rpc === "planning_repeat_copy") return { data: copyReply(c) };
    return {};
  });
}

describe("extendRepeatSeries", () => {
  it("makes tomorrow's copy a day ahead and shifts the alert with it (DST safe)", async () => {
    // Weekly series, latest copy due Sat Oct 31 with a 09:00 EDT alert the day before.
    const { db, calls } = setup(
      [{ series_id: id(1), latest_id: id(1), latest_period: "2026-10-31", rule: "weekly", anchor_day: 31, since: "2026-10-01" }],
      [{ id: id(1), due_date: "2026-10-31", alert_at: "2026-10-30T13:00:00.000Z" }],
    );
    // Nov 6, 2026 in Toronto: the next copy (Nov 7) is due tomorrow.
    const run = await extendRepeatSeries(db, new Date("2026-11-06T15:00:00Z"), TZ);
    expect(run).toEqual({ series: 1, created: 1, ids: [id(900)], failed: [] });
    const copy = calls.find((c) => c.rpc === "planning_repeat_copy") as Call;
    expect(copy.rpcArgs).toEqual({ p_from: id(1), p_due: "2026-11-07", p_alert_at: "2026-11-06T14:00:00.000Z" });
  });

  it("a monthly series on the 31st lands on the last day of a short month, then back on the 31st", async () => {
    // Latest copy Jan 31 with an alert at 09:00 EST the same day.
    const { db, calls } = setup(
      [{ series_id: id(1), latest_id: id(1), latest_period: "2026-01-31", rule: "monthly", anchor_day: 31, since: "2026-01-01" }],
      [{ id: id(1), due_date: "2026-01-31", alert_at: "2026-01-31T14:00:00.000Z" }],
    );
    // Mar 30 in Toronto, after the Mar 8 DST change: Feb 28 is due, Mar 31 is due tomorrow.
    const run = await extendRepeatSeries(db, new Date("2026-03-30T15:00:00Z"), TZ);
    expect(run.created).toBe(2);
    expect(calls.filter((c) => c.rpc === "planning_repeat_copy").map((c) => c.rpcArgs)).toEqual([
      { p_from: id(1), p_due: "2026-02-28", p_alert_at: "2026-02-28T14:00:00.000Z" },
      // 09:00 stays 09:00: EDT is UTC-4 after the spring change.
      { p_from: id(1), p_due: "2026-03-31", p_alert_at: "2026-03-31T13:00:00.000Z" },
    ]);
  });

  it("makes nothing while the next date is still ahead", async () => {
    const { db, calls } = setup(
      [{ series_id: id(1), latest_id: id(1), latest_period: "2026-11-07", rule: "weekly", anchor_day: 7, since: null }],
      [{ id: id(1), due_date: "2026-11-07", alert_at: null }],
    );
    expect(await extendRepeatSeries(db, new Date("2026-11-08T15:00:00Z"), TZ)).toEqual({ series: 1, created: 0, ids: [], failed: [] });
    expect(calls.some((c) => c.rpc === "planning_repeat_copy")).toBe(false);
  });

  it("a copy that already exists (rpc answers null) is not counted: a rerun adds nothing", async () => {
    const { db } = setup(
      [{ series_id: id(1), latest_id: id(1), latest_period: "2026-11-01", rule: "daily", anchor_day: 1, since: null }],
      [{ id: id(1), due_date: "2026-11-01", alert_at: null }],
      () => null,
    );
    expect(await extendRepeatSeries(db, new Date("2026-11-03T15:00:00Z"), TZ)).toEqual({ series: 1, created: 0, ids: [], failed: [] });
  });

  it("caps copies per series, so a long gap never floods", async () => {
    const { db, calls } = setup(
      [{ series_id: id(1), latest_id: id(1), latest_period: "2026-01-01", rule: "daily", anchor_day: 1, since: "2026-01-01" }],
      [{ id: id(1), due_date: "2026-01-01", alert_at: null }],
    );
    const run = await extendRepeatSeries(db, new Date("2026-11-03T15:00:00Z"), TZ, { cap: 3 });
    expect(run.created).toBe(3);
    expect(calls.filter((c) => c.rpc === "planning_repeat_copy").map((c) => (c.rpcArgs as { p_due: string }).p_due)).toEqual([
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ]);
  });

  it("keeps the copies already made and runs later series when one copy fails", async () => {
    const series = [1, 2, 3].map((n) => ({
      series_id: id(n),
      latest_id: id(n),
      latest_period: "2026-11-05",
      rule: "daily",
      anchor_day: null,
      since: "",
    }));
    const { db, calls } = fakeDb((c) => {
      if (c.rpc === "planning_repeat_series") return { data: series };
      if (c.table === "planning_tasks") return { data: [] };
      const { p_from, p_due } = c.rpcArgs as { p_from: string; p_due: string };
      return p_from === id(2) ? { error: { message: "transient" } } : { data: `${p_from}-${p_due}` };
    });
    const run = await extendRepeatSeries(db, new Date("2026-11-06T15:00:00Z"), TZ);
    expect(run.failed).toEqual([id(2)]);
    expect(run.ids).toEqual([
      `${id(1)}-2026-11-06`,
      `${id(1)}-2026-11-07`,
      `${id(3)}-2026-11-06`,
      `${id(3)}-2026-11-07`,
    ]);
    expect(calls.filter((c) => c.rpc === "planning_repeat_copy")).toHaveLength(5);
  });

  it("does nothing when there is no series, and surfaces a database error", async () => {
    expect(await extendRepeatSeries(setup([], []).db, new Date(), TZ)).toEqual({ series: 0, created: 0, ids: [], failed: [] });
    const { db } = fakeDb((c) => (c.rpc === "planning_repeat_series" ? { error: { message: "boom" } } : {}));
    await expect(extendRepeatSeries(db, new Date(), TZ)).rejects.toThrow("boom");
  });
});
