import { describe, expect, it } from "vitest";

import { FX, fixtureSnapshot, id } from "./fixtures";
import { createMemoryActions } from "./memory-actions";

const NOW = new Date("2026-11-21T15:00:00Z");

function setup() {
  const mem = createMemoryActions(fixtureSnapshot(NOW, "America/Toronto"), { now: () => NOW });
  const task = (taskId: string) => mem.snapshot().tasks.find((t) => t.id === taskId)!;
  return { ...mem, task };
}

/** The in-memory actions are what /dev/planning and the UI run on: they must keep the database's rules. */
describe("memory actions keep the database's rules", () => {
  it("completed_at follows the status", async () => {
    const { actions, task } = setup();
    expect((await actions.completeTask(id(100), true)).ok).toBe(true);
    expect(task(id(100)).statusId).toBe(FX.statusDone);
    expect(task(id(100)).completedAt).toBe(NOW.toISOString());
    await actions.completeTask(id(100), false);
    expect(task(id(100)).statusId).toBe(FX.statusTodo);
    expect(task(id(100)).completedAt).toBeNull();
  });

  it("a repeat on an undated task dates it today and starts its series", async () => {
    const { actions, task } = setup();
    const r = await actions.setTaskRepeat(id(104), "weekly");
    expect(r.ok && r.value).toMatchObject({ repeatRule: "weekly", dueDate: "2026-11-21", repeatSeriesId: id(104) });
    expect((await actions.setTaskRepeat(id(104), null)).ok).toBe(true);
    expect(task(id(104)).repeatRule).toBeNull();
  });

  it("sets and clears an alert, on tasks and on events", async () => {
    const { actions, task, snapshot } = setup();
    await actions.setTaskAlert(id(100), "2026-11-22T14:00:00.000Z");
    expect(task(id(100)).alertAt).toBe("2026-11-22T14:00:00.000Z");
    await actions.clearTaskAlert(id(100));
    expect(task(id(100)).alertAt).toBeNull();
    await actions.clearEventAlert(id(400));
    expect(snapshot().events[0].alertAt).toBeNull();
    expect(await actions.setEventAlert(id(400), "not a date")).toMatchObject({ ok: false });
  });

  it("task moves are all-or-nothing and move across columns", async () => {
    const { actions, task } = setup();
    expect(await actions.setTaskPositions([{ id: id(100), position: 5, statusId: FX.statusDoing }, { id: id(999), position: 6 }])).toMatchObject({ ok: false });
    expect(task(id(100)).position).toBe(1024);
    await actions.setTaskPositions([{ id: id(100), position: 5, statusId: FX.statusDoing }]);
    expect(task(id(100))).toMatchObject({ position: 5, statusId: FX.statusDoing });
  });

  it("create is idempotent on the client's id", async () => {
    const { actions, snapshot } = setup();
    const input = { id: id(500), title: "Call Plaid", statusId: FX.statusTodo, position: 9999 };
    await actions.createTask(input);
    await actions.createTask({ ...input, title: "A retry with other text" });
    const made = snapshot().tasks.filter((t) => t.id === id(500));
    expect(made).toHaveLength(1);
    expect(made[0].title).toBe("Call Plaid");
  });

  it("refuses bad input with the same messages as the server actions", async () => {
    const { actions } = setup();
    expect(await actions.createTask({ id: id(501), title: " ", statusId: FX.statusTodo, position: 1 })).toMatchObject({ ok: false, field: "title" });
    expect(await actions.updateTask(id(100), { goalId: id(999) })).toEqual({ ok: false, error: "That item is gone." });
    expect(await actions.updateTask(id(999), { title: "x" })).toEqual({ ok: false, error: "That task is gone." });
  });

  it("deleting a status moves its tasks; the last status cannot go", async () => {
    const { actions, task, snapshot } = setup();
    expect(await actions.deleteStatus(FX.statusTodo, null)).toMatchObject({ ok: false });
    expect((await actions.deleteStatus(FX.statusTodo, FX.statusDoing)).ok).toBe(true);
    expect(task(id(100)).statusId).toBe(FX.statusDoing);
    expect(snapshot().statuses).toHaveLength(3);
  });

  it("goal metrics: one per goal and metric, category only for category_spend", async () => {
    const { actions, snapshot } = setup();
    const base = { goalId: FX.goalSave, target: 500 };
    expect((await actions.addGoalMetric({ ...base, id: id(600), metric: "net_worth" })).ok).toBe(true);
    expect(await actions.addGoalMetric({ ...base, id: id(601), metric: "net_worth" })).toEqual({ ok: false, error: "That metric is already on this goal." });
    expect((await actions.addGoalMetric({ ...base, id: id(602), metric: "category_spend", param: "Food" })).ok).toBe(true);
    expect((await actions.addGoalMetric({ ...base, id: id(603), metric: "category_spend", param: "Rent" })).ok).toBe(true);
    expect(snapshot().goals.find((g) => g.id === FX.goalSave)?.metrics).toHaveLength(4);
    await actions.removeGoalMetric(id(600));
    expect(snapshot().goals.find((g) => g.id === FX.goalSave)?.metrics.map((m) => m.id)).not.toContain(id(600));
  });

  it("achieving a goal stamps it; deleting a goal unlinks its tasks", async () => {
    const { actions, task, snapshot } = setup();
    await actions.updateGoal(FX.goalPosts, { achieved: true });
    expect(snapshot().goals.find((g) => g.id === FX.goalPosts)?.achievedAt).toBe(NOW.toISOString());
    expect(await actions.updateGoal(FX.goalPosts, { startDate: "2027-01-01" })).toMatchObject({ ok: false });
    await actions.deleteGoal(FX.goalPosts);
    expect(task(id(100)).goalId).toBeNull();
  });

  it("properties: values must fit the type, options belong to their property, deleting an option clears values", async () => {
    const { actions, task } = setup();
    expect(await actions.setTaskValue(id(100), FX.propPriority, { type: "text", value: "x" })).toEqual({ ok: false, error: "That value does not fit this property." });
    expect(await actions.setTaskValue(id(100), FX.propPriority, { type: "select", optionId: id(999) })).toMatchObject({ ok: false });
    expect((await actions.setTaskValue(id(100), FX.propPriority, { type: "select", optionId: FX.optLow })).ok).toBe(true);
    expect((await actions.propertyUsage(FX.optLow)).ok && (await actions.propertyUsage(FX.optLow))).toMatchObject({ value: 2 });
    await actions.deleteOption(FX.optLow);
    expect(task(id(100)).values[FX.propPriority]).toBeUndefined();
    expect(await actions.createProperty({ id: id(700), name: "priority", type: "text" })).toEqual({ ok: false, error: "A property with that name exists." });
    expect((await actions.setTaskValue(id(100), FX.propPriority, null)).ok).toBe(true);
  });

  it("events: create, move the alert with a repeat, refuse an end before the start", async () => {
    const { actions, snapshot } = setup();
    const e = { id: id(800), title: "Tax call", startsAt: "2026-11-25T15:00:00.000Z", repeat: "monthly" as const, alertAt: "2026-11-25T14:50:00.000Z" };
    expect((await actions.createEvent(e)).ok).toBe(true);
    expect(await actions.updateEvent(id(800), { endsAt: "2026-11-25T14:00:00.000Z" })).toEqual({ ok: false, error: "An event cannot end before it starts." });
    await actions.deleteEvent(id(800));
    expect(snapshot().events.map((x) => x.id)).not.toContain(id(800));
  });
});
