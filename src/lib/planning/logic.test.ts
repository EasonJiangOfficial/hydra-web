import { describe, expect, it } from "vitest";

import { FX, fixtureSnapshot, id } from "./fixtures";
import { readGoal, sortGoals } from "./goals";
import {
  METRICS,
  createMetricRegistry,
  defaultMetricRegistry,
  formatMetric,
  goalPercent,
  goalWindow,
  metricPercent,
} from "./metrics";
import { positionBetween, renormalize } from "./ordering";
import {
  comparePropertyValues,
  formatPropertyValue,
  matchesPropertyFilter,
  propertyValueSchema,
  valueFromRow,
  valueToColumns,
} from "./properties";
import { snapshotFromRows } from "./repository";
import {
  createEventSchema,
  createTaskSchema,
  goalMetricInputSchema,
  taskPatchSchema,
  taskPositionUpdatesSchema,
} from "./schemas";
import { categoriesOf, completedAtFor, filterTasks, liveFilters, placeAmong, sortTasks, statusForDone } from "./tasks";
import { DEFAULT_FILTERS } from "./types";

const NOW = new Date("2026-11-21T15:00:00Z");
const snap = fixtureSnapshot(NOW, "America/Toronto");

describe("ordering and placing", () => {
  it("positions between, before and after", () => {
    expect(positionBetween(null, null)).toBe(1024);
    expect(positionBetween(1024, 2048)).toBe(1536);
    expect(positionBetween(null, 1024)).toBe(0);
    expect(positionBetween(2048, null)).toBe(3072);
  });

  it("placeAmong lands after, before, or last, and renormalizes a crushed gap", () => {
    const rows = [
      { id: "a", position: 1024 },
      { id: "b", position: 2048 },
    ];
    expect(placeAmong(rows, "x", "a", null).position).toBe(1536);
    expect(placeAmong(rows, "x", null, "a").position).toBe(0);
    expect(placeAmong(rows, "x", null, null).position).toBe(3072);
    const tight = [
      { id: "a", position: 1 },
      { id: "b", position: 1 + 1e-9 },
    ];
    const r = placeAmong(tight, "x", "a", "b");
    expect(r.renormalized).toEqual(renormalize(["a", "x", "b"]));
    expect(r.position).toBe(2048);
  });
});

describe("tasks", () => {
  it("completedAt follows the status like the database trigger", () => {
    const t = snap.tasks[0];
    const stamp = NOW.toISOString();
    expect(completedAtFor(t, FX.statusDone, snap.statuses, NOW)).toBe(stamp);
    expect(completedAtFor(t, FX.statusDoing, snap.statuses, NOW)).toBeNull();
    const done = { ...t, statusId: FX.statusDone, completedAt: "2026-11-01T00:00:00Z" };
    expect(completedAtFor(done, FX.statusDone, snap.statuses, NOW)).toBe("2026-11-01T00:00:00Z");
    expect(completedAtFor(done, FX.statusTodo, snap.statuses, NOW)).toBeNull();
  });

  it("statusForDone picks the first done or the first not-done status", () => {
    expect(statusForDone(snap.statuses, true)?.id).toBe(FX.statusDone);
    expect(statusForDone(snap.statuses, false)?.id).toBe(FX.statusTodo);
  });

  it("filters by search, goal, category, done and property", () => {
    const ctx = { statuses: snap.statuses };
    expect(filterTasks(snap.tasks, { ...DEFAULT_FILTERS, search: "w-9" }, ctx).map((t) => t.id)).toEqual([id(101)]);
    expect(filterTasks(snap.tasks, { ...DEFAULT_FILTERS, goal: FX.goalTax }, ctx)).toHaveLength(2);
    expect(filterTasks(snap.tasks, { ...DEFAULT_FILTERS, goal: "none" }, ctx).every((t) => t.goalId === null)).toBe(true);
    expect(filterTasks(snap.tasks, { ...DEFAULT_FILTERS, category: "Taxes" }, ctx)).toHaveLength(3);
    expect(filterTasks(snap.tasks, { ...DEFAULT_FILTERS, hideDone: true }, ctx).some((t) => t.statusId === FX.statusDone)).toBe(false);
    const urgent = { [FX.propPriority]: { kind: "any_of" as const, ids: [FX.optUrgent] } };
    expect(filterTasks(snap.tasks, { ...DEFAULT_FILTERS, properties: urgent }, ctx).map((t) => t.id).sort()).toEqual([id(103), id(107)]);
  });

  it("a filter whose goal or category is gone falls back to the default", () => {
    const stale = { ...DEFAULT_FILTERS, goal: id(999), category: "Nope" };
    const live = liveFilters(stale, snap);
    expect(live.goal).toBe("all");
    expect(live.category).toBe("all");
    expect(liveFilters(DEFAULT_FILTERS, snap)).toBe(DEFAULT_FILTERS);
  });

  it("sorts with empty values last in both directions", () => {
    const due = (dir: "asc" | "desc") => sortTasks(snap.tasks, { key: "due", dir }, snap.statuses).map((t) => t.dueDate);
    expect(due("asc").at(-1)).toBeNull();
    expect(due("desc").at(-1)).toBeNull();
    expect(due("asc")[0]).toBe(snap.tasks.find((t) => t.id === id(105))?.dueDate);
    const byPriority = sortTasks(snap.tasks, { key: `prop:${FX.propPriority}`, dir: "asc" }, snap.statuses, { properties: snap.properties });
    expect(byPriority[0].values[FX.propPriority]).toEqual({ type: "select", optionId: FX.optUrgent });
    expect(Object.keys(byPriority.at(-1)?.values ?? {})).not.toContain(FX.propPriority);
  });

  it("lists categories in use on tasks, goals and events", () => {
    expect(categoriesOf(snap)).toEqual(["Hydra", "Money", "Taxes", "UGC"]);
  });

  it("sorts goals by deadline, undated last", () => {
    expect(sortGoals(snap.goals).map((g) => g.id)).toEqual([FX.goalPosts, FX.goalTax, FX.goalSave]);
  });
});

describe("metric registry", () => {
  const goal = snap.goals[0];
  const ctx = {
    goalId: goal.id,
    window: goalWindow(goal, "2026-11-21", "America/Toronto"),
    today: "2026-11-21",
    timeZone: "America/Toronto",
    tasks: snap.tasks,
    statuses: snap.statuses,
  };

  it("has a definition for every key the database allows", () => {
    expect(Object.keys(METRICS).sort()).toEqual(
      [
        "net_worth", "monthly_income", "ugc_revenue", "savings_rate", "category_spend",
        "posts_per_day", "streak", "total_views", "views_per_post", "task_progress",
      ].sort(),
    );
  });

  it("answers with a stub until a unit registers a resolver", async () => {
    expect(await defaultMetricRegistry.resolve("net_worth", null, ctx)).toEqual({ value: 48_212, stub: true });
    const live = defaultMetricRegistry.register("net_worth", () => 51_000);
    expect(await live.resolve("net_worth", null, ctx)).toEqual({ value: 51_000, stub: false });
    // register never changes the registry it came from
    expect((await defaultMetricRegistry.resolve("net_worth", null, ctx)).stub).toBe(true);
    expect(live.has("net_worth")).toBe(true);
    expect(createMetricRegistry().has("streak")).toBe(false);
  });

  it("passes the category param to category_spend", async () => {
    const reg = createMetricRegistry({ category_spend: (param) => (param === "Food" ? 310 : 0) });
    expect((await reg.resolve("category_spend", "Food", ctx)).value).toBe(310);
  });

  it("task progress is real: done linked tasks over all linked tasks", async () => {
    // goalPosts links 100 (todo), 103 (doing), 106 (done): 1 of 3.
    expect(await defaultMetricRegistry.resolve("task_progress", null, ctx)).toEqual({ value: 33, stub: false });
    const empty = { ...ctx, goalId: id(777) };
    expect((await defaultMetricRegistry.resolve("task_progress", null, empty)).value).toBeNull();
  });

  it("a cap goal is full at or under its target, then falls", () => {
    const down = METRICS.category_spend;
    expect(metricPercent(down, 300, 400)).toBe(100);
    expect(metricPercent(down, 400, 400)).toBe(100);
    expect(metricPercent(down, 800, 400)).toBe(50);
    expect(metricPercent(METRICS.net_worth, 25_000, 50_000)).toBe(50);
    expect(metricPercent(METRICS.net_worth, 90_000, 50_000)).toBe(100);
    expect(metricPercent(METRICS.net_worth, null, 50_000)).toBe(0);
  });

  it("formats each unit", () => {
    expect(formatMetric(METRICS.net_worth, 48_212.4)).toBe("$48,212");
    expect(formatMetric(METRICS.savings_rate, 31)).toBe("31%");
    expect(formatMetric(METRICS.streak, 1)).toBe("1 day");
    expect(formatMetric(METRICS.streak, 9)).toBe("9 days");
    expect(formatMetric(METRICS.posts_per_day, 2.44)).toBe("2.4");
    expect(formatMetric(METRICS.total_views, null)).toBe("-");
  });

  it("a goal's percent averages its metrics, or falls back to its tasks", async () => {
    expect(goalPercent({ id: "g", metrics: [] }, {}, { done: 1, total: 4 })).toBe(25);
    const reading = await readGoal(goal, { tasks: snap.tasks, statuses: snap.statuses, today: "2026-11-21", timeZone: "America/Toronto" });
    // posts_per_day stub 2.4 of 3 = 80; task_progress 33 of 100 = 33; average 56.5 -> 57
    expect(reading.metrics.map((m) => [m.percent, m.stub])).toEqual([[80, true], [33, false]]);
    expect(reading.percent).toBe(57);
    expect(reading.tasks).toEqual({ done: 1, total: 3, percent: 33 });
  });

  it("the window starts on the goal's start date, else the day it was made", () => {
    expect(goalWindow({ startDate: "2026-11-01", deadline: null, createdAt: "2026-10-01T12:00:00Z" }, "2026-11-21", "America/Toronto")).toEqual({
      from: "2026-11-01",
      to: "2026-11-21",
    });
    expect(goalWindow({ startDate: null, deadline: "2026-12-31", createdAt: "2026-10-01T03:00:00Z" }, "2026-11-21", "America/Toronto")).toEqual({
      from: "2026-09-30",
      to: "2026-12-31",
    });
  });
});

describe("properties", () => {
  const priority = snap.properties[0];

  it("values round-trip through database columns", () => {
    const v = { type: "multi_select", optionIds: [FX.optHigh, FX.optLow] } as const;
    expect(valueFromRow("multi_select", { ...valueToColumns(v) })).toEqual(v);
    expect(valueFromRow("number", { ...valueToColumns({ type: "number", value: 3 }) })).toEqual({ type: "number", value: 3 });
    expect(valueFromRow("checkbox", { ...valueToColumns({ type: "checkbox", value: true }) })).toEqual({ type: "checkbox", value: true });
    expect(valueFromRow("text", { ...valueToColumns({ type: "text", value: "x" }), text_value: "" })).toBeNull();
  });

  it("the value schema refuses empties and bad urls", () => {
    expect(propertyValueSchema.safeParse(null).success).toBe(true);
    expect(propertyValueSchema.safeParse({ type: "text", value: "  " }).success).toBe(false);
    expect(propertyValueSchema.safeParse({ type: "url", value: "javascript:alert(1)" }).success).toBe(false);
    expect(propertyValueSchema.safeParse({ type: "url", value: "https://hydra.test/x" }).success).toBe(true);
    expect(propertyValueSchema.safeParse({ type: "checkbox", value: false }).success).toBe(false);
    expect(propertyValueSchema.safeParse({ type: "person", memberIds: [], personIds: [] }).success).toBe(false);
    expect(propertyValueSchema.safeParse({ type: "multi_select", optionIds: [] }).success).toBe(false);
  });

  it("formats, filters and compares values", () => {
    expect(formatPropertyValue(priority, { type: "select", optionId: FX.optHigh })).toBe("High");
    expect(formatPropertyValue(snap.properties[1], { type: "number", value: 1200 })).toBe("1,200");
    expect(matchesPropertyFilter(undefined, { kind: "empty" })).toBe(true);
    expect(matchesPropertyFilter({ type: "number", value: 5 }, { kind: "range", min: 6 })).toBe(false);
    const a = { type: "select", optionId: FX.optUrgent } as const;
    const b = { type: "select", optionId: FX.optLow } as const;
    expect(comparePropertyValues(priority, a, b)).toBeLessThan(0);
    expect(comparePropertyValues(priority, undefined, b, "desc")).toBe(1);
  });
});

describe("schemas", () => {
  it("createTask fills defaults and refuses a blank title", () => {
    const ok = createTaskSchema.parse({ id: id(1), title: "  Call  ", statusId: id(2), position: 1 });
    expect(ok).toMatchObject({ title: "Call", goalId: null, category: null, dueDate: null, alertAt: null, repeatRule: null });
    expect(createTaskSchema.safeParse({ id: id(1), title: "  ", statusId: id(2), position: 1 }).success).toBe(false);
  });

  it("a patch is strict and never empty", () => {
    expect(taskPatchSchema.safeParse({}).success).toBe(false);
    expect(taskPatchSchema.safeParse({ bogus: 1 }).success).toBe(false);
    expect(taskPatchSchema.safeParse({ repeatRule: "yearly" }).success).toBe(false);
    expect(taskPatchSchema.safeParse({ alertAt: "2026-11-24T14:00:00.000Z" }).success).toBe(true);
    expect(taskPatchSchema.safeParse({ alertAt: "tomorrow" }).success).toBe(false);
  });

  it("task moves refuse a repeated task", () => {
    expect(taskPositionUpdatesSchema.safeParse([{ id: id(1), position: 1 }, { id: id(1), position: 2 }]).success).toBe(false);
  });

  it("a metric takes a category only for category_spend, and a savings rate is at most 100", () => {
    const base = { id: id(1), goalId: id(2), target: 100 };
    expect(goalMetricInputSchema.safeParse({ ...base, metric: "category_spend" }).success).toBe(false);
    expect(goalMetricInputSchema.safeParse({ ...base, metric: "category_spend", param: "Food" }).success).toBe(true);
    expect(goalMetricInputSchema.safeParse({ ...base, metric: "net_worth", param: "Food" }).success).toBe(false);
    expect(goalMetricInputSchema.safeParse({ ...base, metric: "savings_rate", target: 150 }).success).toBe(false);
    expect(goalMetricInputSchema.safeParse({ ...base, metric: "nonsense" }).success).toBe(false);
  });

  it("an event cannot end before it starts", () => {
    const base = { id: id(1), title: "x", startsAt: "2026-11-24T10:00:00.000Z" };
    expect(createEventSchema.safeParse({ ...base, endsAt: "2026-11-24T09:00:00.000Z" }).success).toBe(false);
    expect(createEventSchema.safeParse({ ...base, endsAt: "2026-11-24T11:00:00.000Z", repeat: "weekly" }).success).toBe(true);
  });
});

describe("repository mapping", () => {
  it("builds a snapshot from rows: values by task, goals with metrics and links, ordered", () => {
    const row = (over: object) => ({ created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", ...over });
    const snapshot = snapshotFromRows({
      timeZone: "America/Toronto",
      statuses: [
        row({ id: "s2", label: "Done", color: "#8e8e93", position: 1, is_done: true }),
        row({ id: "s1", label: "Todo", color: "#c7c7cc", position: 0, is_done: false }),
      ] as never,
      goals: [row({ id: "g1", title: "G", notes: "", category: "UGC", start_date: null, deadline: null, position: 1, achieved_at: null })] as never,
      metrics: [
        row({ id: "m2", goal_id: "g1", metric: "streak", target: "9", param: null, position: 2 }),
        row({ id: "m1", goal_id: "g1", metric: "net_worth", target: "50000.5", param: null, position: 1 }),
      ] as never,
      links: [row({ id: "l1", goal_id: "g1", url: "https://a.test", title: null, position: 1 })] as never,
      tasks: [
        row({ id: "t1", title: "T", notes: "", status_id: "s1", goal_id: "g1", category: null, due_date: "2026-11-24", position: 1, alert_at: null, repeat_rule: "weekly", repeat_series_id: "t1", repeat_period: "2026-11-24", repeat_anchor_day: 24, repeat_since: "2026-11-21", completed_at: null }),
      ] as never,
      events: [row({ id: "e1", title: "E", starts_at: "2026-11-24T15:00:00+00:00", ends_at: null, all_day: false, category: null, repeat: "bogus", notes: "", alert_at: null, google_event_id: null })] as never,
      properties: [row({ id: "p1", name: "Priority", type: "select", number_format: "number", position: 0, show_on_board: true, show_in_list: true })] as never,
      options: [row({ id: "o1", property_id: "p1", label: "High", color: "#424245", position: 0 })] as never,
      values: [
        row({ task_id: "t1", property_id: "p1", text_value: null, number_value: null, date_value: null, bool_value: null, option_ids: ["o1"] }),
        row({ task_id: "t1", property_id: "gone", text_value: "x", number_value: null, date_value: null, bool_value: null, option_ids: null }),
      ] as never,
    });
    expect(snapshot.statuses.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(snapshot.tasks[0].values).toEqual({ p1: { type: "select", optionId: "o1" } });
    expect(snapshot.tasks[0].repeatRule).toBe("weekly");
    expect(snapshot.goals[0].metrics.map((m) => [m.id, m.target])).toEqual([["m1", 50000.5], ["m2", 9]]);
    expect(snapshot.goals[0].links).toHaveLength(1);
    expect(snapshot.events[0].repeat).toBeNull();
    expect(snapshot.properties[0].options[0].label).toBe("High");
  });
});
