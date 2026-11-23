import { beforeEach, describe, expect, it, vi } from "vitest";

import * as actions from "./actions";
import { id } from "./fixtures";
import { PlanningError } from "./result";
import { ownerCtx } from "./server";
import { argsOf, fakeDb, used, type Call, type Reply } from "./test-db";

vi.mock("./server", () => ({ ownerCtx: vi.fn() }));

const google = vi.hoisted(() => ({
  later: [] as Array<() => Promise<unknown>>,
  push: vi.fn(async () => ({ ok: true, data: "not_connected" })),
  remove: vi.fn(async () => ({ ok: true, data: "not_connected" })),
}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => void google.later.push(fn) }));
vi.mock("@/lib/google/calendar", () => ({ pushToGoogle: google.push, removeFromGoogle: google.remove }));

const NOW = new Date("2026-11-21T15:00:00Z"); // Nov 21 in Toronto
const taskRow = (over: object = {}) => ({
  id: id(1),
  title: "T",
  notes: "",
  status_id: id(2),
  goal_id: null,
  category: null,
  due_date: "2026-11-24",
  position: 1024,
  alert_at: null,
  repeat_rule: null,
  repeat_series_id: null,
  repeat_period: null,
  repeat_anchor_day: null,
  repeat_since: null,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  completed_at: null,
  ...over,
});

function setup(reply: (call: Call) => Reply) {
  const { db, calls } = fakeDb(reply);
  vi.mocked(ownerCtx).mockResolvedValue({ db, now: () => NOW, timeZone: async () => "America/Toronto" });
  return calls;
}

beforeEach(() => {
  vi.mocked(ownerCtx).mockReset();
  google.later.length = 0;
  google.push.mockClear();
  google.remove.mockClear();
});

/** Run what after() queued (Next runs it once the response is sent). */
const flushAfter = () => Promise.all(google.later.splice(0).map((fn) => fn()));

describe("owner gate and validation", () => {
  it("refuses anyone who is not the owner before touching the database", async () => {
    vi.mocked(ownerCtx).mockImplementation(async () => {
      throw new PlanningError("Not allowed.");
    });
    expect(await actions.deleteTask(id(1))).toEqual({ ok: false, error: "Not allowed." });
    expect(await actions.createGoal({ id: id(1), title: "x", position: 1 })).toEqual({ ok: false, error: "Not allowed." });
  });

  it("rejects bad input with its field and never calls the database", async () => {
    const calls = setup(() => ({ data: taskRow() }));
    const r = await actions.createTask({ id: id(1), title: "  ", statusId: id(2), position: 1 });
    expect(r).toMatchObject({ ok: false, field: "title" });
    expect(await actions.updateTask(id(1), {})).toMatchObject({ ok: false });
    expect(await actions.updateTask("not-an-id", { title: "x" })).toMatchObject({ ok: false });
    expect(await actions.setTaskAlert(id(1), "tomorrow")).toMatchObject({ ok: false });
    expect(await actions.setTaskPositions([{ id: id(1), position: 1 }, { id: id(1), position: 2 }])).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it("hides unexpected failures behind a plain message", async () => {
    setup(() => ({ error: { message: "connection reset" } }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await actions.deleteTask(id(1))).toEqual({ ok: false, error: "Something went wrong. Try again." });
  });

  it("turns a known database refusal into a readable one", async () => {
    setup((c) =>
      c.table === "planning_tasks" && used(c, "update")
        ? { error: { message: 'new row violates check constraint "planning_tasks_repeat_needs_due"', code: "23514" } }
        : {},
    );
    expect(await actions.updateTask(id(1), { dueDate: null })).toEqual({ ok: false, error: "A repeating task needs a due date." });
  });
});

describe("tasks", () => {
  it("updates only the columns in the patch, by id", async () => {
    const calls = setup(() => ({ data: taskRow({ title: "New" }) }));
    const r = await actions.updateTask(id(1), { title: "New", statusId: id(3), goalId: null });
    expect(r.ok && r.value.title).toBe("New");
    expect(argsOf(calls[0], "update")?.[0]).toEqual({ title: "New", status_id: id(3), goal_id: null });
    expect(used(calls[0], "eq", "id", id(1))).toBe(true);
  });

  it("creates on the client's id, ignoring a duplicate, and reads the row back", async () => {
    const calls = setup((c) => (used(c, "maybeSingle") ? { data: taskRow({ alert_at: "2026-11-24T14:00:00+00:00" }) } : {}));
    const r = await actions.createTask({ id: id(1), title: "Send W-9", statusId: id(2), position: 1024, alertAt: "2026-11-24T14:00:00.000Z" });
    expect(r.ok && r.value.alertAt).toBe("2026-11-24T14:00:00+00:00");
    expect(argsOf(calls[0], "upsert")?.[1]).toEqual({ onConflict: "id", ignoreDuplicates: true });
    expect(argsOf(calls[0], "upsert")?.[0]).toMatchObject({ id: id(1), title: "Send W-9", alert_at: "2026-11-24T14:00:00.000Z", repeat_rule: null });
  });

  it("a repeat on an undated task dates it today in the owner's zone", async () => {
    const calls = setup((c) => (used(c, "select", "due_date") ? { data: { due_date: null } } : { data: taskRow({ repeat_rule: "weekly" }) }));
    const r = await actions.setTaskRepeat(id(1), "weekly");
    expect(r.ok && r.value.repeatRule).toBe("weekly");
    const update = calls.find((c) => used(c, "update"));
    expect(argsOf(update as Call, "update")?.[0]).toEqual({ repeat_rule: "weekly", due_date: "2026-11-21" });
  });

  it("a repeat on a dated task leaves the date alone; stopping it sends only null", async () => {
    const calls = setup((c) => (used(c, "select", "due_date") ? { data: { due_date: "2026-11-24" } } : { data: taskRow() }));
    await actions.setTaskRepeat(id(1), "monthly");
    expect(argsOf(calls.find((c) => used(c, "update")) as Call, "update")?.[0]).toEqual({ repeat_rule: "monthly" });
    calls.length = 0;
    await actions.setTaskRepeat(id(1), null);
    expect(argsOf(calls[0], "update")?.[0]).toEqual({ repeat_rule: null });
  });

  it("sets and clears an alert", async () => {
    const calls = setup(() => ({ data: taskRow() }));
    await actions.setTaskAlert(id(1), "2026-11-24T14:00:00.000Z");
    await actions.clearTaskAlert(id(1));
    expect(calls.map((c) => argsOf(c, "update")?.[0])).toEqual([{ alert_at: "2026-11-24T14:00:00.000Z" }, { alert_at: null }]);
  });

  it("moves tasks in one rpc call with snake_case items", async () => {
    const calls = setup(() => ({}));
    const r = await actions.setTaskPositions([{ id: id(1), position: 2048, statusId: id(3) }, { id: id(2), position: 1024 }]);
    expect(r).toEqual({ ok: true, value: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].rpc).toBe("planning_set_task_positions");
    expect(JSON.parse(JSON.stringify(calls[0].rpcArgs))).toEqual({
      p_items: [{ id: id(1), position: 2048, status_id: id(3) }, { id: id(2), position: 1024 }],
    });
  });

  it("complete moves to the first done status at the end of that column; reopen to the first open one", async () => {
    const statuses = [
      { id: id(2), label: "Todo", color: "#c7c7cc", position: 0, is_done: false, created_at: "" },
      { id: id(4), label: "Done", color: "#8e8e93", position: 1, is_done: true, created_at: "" },
    ];
    const calls = setup((c) => {
      if (c.table === "planning_statuses") return { data: statuses };
      if (used(c, "update")) return { data: taskRow({ status_id: id(4) }) };
      return { data: [{ position: 3072 }] };
    });
    await actions.completeTask(id(1), true);
    const update = calls.find((c) => used(c, "update")) as Call;
    expect(argsOf(update, "update")?.[0]).toEqual({ status_id: id(4), position: 4096 });
    calls.length = 0;
    await actions.completeTask(id(1), false);
    expect(argsOf(calls.find((c) => used(c, "update")) as Call, "update")?.[0]).toMatchObject({ status_id: id(2) });
  });
});

describe("goals, metrics and links", () => {
  it("achieving a goal stamps achieved_at with the owner's clock; undoing clears it", async () => {
    const calls = setup((c) => (c.table === "planning_goals" ? { data: { id: id(10), title: "G", notes: "", position: 1, created_at: "", updated_at: "" } } : { data: [] }));
    await actions.updateGoal(id(10), { achieved: true, title: "G2" });
    await actions.updateGoal(id(10), { achieved: false });
    const updates = calls.filter((c) => used(c, "update")).map((c) => argsOf(c, "update")?.[0]);
    expect(updates).toEqual([{ title: "G2", achieved_at: NOW.toISOString() }, { achieved_at: null }]);
  });

  it("category spend must name a category", async () => {
    const calls = setup(() => ({}));
    const r = await actions.addGoalMetric({ id: id(1), goalId: id(10), metric: "category_spend", target: 400 });
    expect(r).toMatchObject({ ok: false, field: "param" });
    expect(calls).toHaveLength(0);
  });

  it("adds a metric after the last one", async () => {
    const calls = setup((c) =>
      used(c, "insert")
        ? { data: { id: id(1), goal_id: id(10), metric: "net_worth", target: "50000", param: null, position: 3072 } }
        : { data: [{ position: 2048 }] },
    );
    const r = await actions.addGoalMetric({ id: id(1), goalId: id(10), metric: "net_worth", target: 50000 });
    expect(r.ok && r.value.target).toBe(50000);
    expect(argsOf(calls.find((c) => used(c, "insert")) as Call, "insert")?.[0]).toMatchObject({ metric: "net_worth", position: 3072 });
  });

  it("a duplicate metric reads as a plain message", async () => {
    setup((c) =>
      used(c, "insert")
        ? { error: { message: 'duplicate key value violates unique constraint "planning_goal_metrics_goal_metric_param_key"', code: "23505" } }
        : { data: [] },
    );
    expect(await actions.addGoalMetric({ id: id(1), goalId: id(10), metric: "streak", target: 9 })).toEqual({
      ok: false,
      error: "That metric is already on this goal.",
    });
  });

  it("links must be http or https", async () => {
    setup(() => ({}));
    expect(await actions.addGoalLink({ id: id(1), goalId: id(10), url: "javascript:alert(1)" })).toMatchObject({ ok: false, field: "url" });
    expect(await actions.addGoalLink({ id: id(1), goalId: id(10), url: "ftp://x.test/f" })).toMatchObject({ ok: false });
  });
});

describe("events", () => {
  it("creates with defaults and sets an alert", async () => {
    const calls = setup((c) =>
      used(c, "maybeSingle")
        ? { data: { id: id(5), title: "Review", starts_at: "2026-11-24T15:00:00+00:00", ends_at: null, all_day: false, category: null, repeat: "weekly", notes: "", alert_at: null, google_event_id: null, created_at: "", updated_at: "" } }
        : {},
    );
    const r = await actions.createEvent({ id: id(5), title: "Review", startsAt: "2026-11-24T15:00:00.000Z", repeat: "weekly" });
    expect(r.ok && r.value.repeat).toBe("weekly");
    expect(argsOf(calls[0], "upsert")?.[0]).toMatchObject({ id: id(5), all_day: false, notes: "", repeat: "weekly" });
    calls.length = 0;
    await actions.setEventAlert(id(5), "2026-11-24T14:50:00.000Z");
    expect(argsOf(calls[0], "update")?.[0]).toEqual({ alert_at: "2026-11-24T14:50:00.000Z" });
  });

  it("refuses an event that ends before it starts", async () => {
    const calls = setup(() => ({}));
    const r = await actions.createEvent({ id: id(5), title: "x", startsAt: "2026-11-24T15:00:00.000Z", endsAt: "2026-11-24T14:00:00.000Z" });
    expect(r).toMatchObject({ ok: false, field: "endsAt" });
    expect(calls).toHaveLength(0);
  });
});

describe("Google calendar mirror", () => {
  it("pushes a task or event after a write that worked, and removes it after a delete", async () => {
    setup((c) => (used(c, "maybeSingle") ? { data: c.table === "events" ? { id: id(5), title: "E", starts_at: "2026-11-24T15:00:00+00:00", ends_at: null, all_day: false, category: null, repeat: null, notes: "", alert_at: null, created_at: "", updated_at: "" } : taskRow() } : {}));
    expect((await actions.updateTask(id(1), { title: "x" })).ok).toBe(true);
    expect((await actions.updateEvent(id(5), { title: "E" })).ok).toBe(true);
    expect((await actions.deleteTask(id(1))).ok).toBe(true);
    expect(google.push).not.toHaveBeenCalled(); // only after the response
    await flushAfter();
    expect(google.push.mock.calls).toEqual([["task", id(1)], ["event", id(5)]]);
    expect(google.remove.mock.calls).toEqual([["task", id(1)]]);
  });

  it("does nothing when the write failed", async () => {
    setup(() => ({ error: { message: "connection reset" } }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await actions.updateTask(id(1), { title: "x" })).ok).toBe(false);
    expect((await actions.deleteEvent(id(5))).ok).toBe(false);
    await flushAfter();
    expect(google.push).not.toHaveBeenCalled();
    expect(google.remove).not.toHaveBeenCalled();
  });

  it("not connected to Google: the result is unchanged and nothing is logged", async () => {
    setup((c) => (used(c, "maybeSingle") ? { data: taskRow() } : {}));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await actions.updateTask(id(1), { title: "x" });
    await flushAfter();
    expect(r).toMatchObject({ ok: true, value: { id: id(1) } });
    expect(google.push.mock.calls).toEqual([["task", id(1)]]);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("statuses and properties", () => {
  it("deleting a status moves its tasks through the rpc", async () => {
    const calls = setup(() => ({}));
    await actions.deleteStatus(id(2), id(3));
    expect(calls[0].rpc).toBe("planning_delete_status");
    expect(calls[0].rpcArgs).toEqual({ p_status: id(2), p_move_to: id(3) });
  });

  it("clears a task value by deleting its row", async () => {
    const calls = setup(() => ({}));
    expect(await actions.setTaskValue(id(1), id(20), null)).toEqual({ ok: true, value: null });
    expect(calls[0].table).toBe("planning_task_values");
    expect(used(calls[0], "delete")).toBe(true);
    expect(used(calls[0], "eq", "property_id", id(20))).toBe(true);
  });

  it("saves a value only on a property of the same type", async () => {
    const calls = setup((c) => (c.table === "planning_properties" ? { data: { type: "select" } } : {}));
    const bad = await actions.setTaskValue(id(1), id(20), { type: "text", value: "x" });
    expect(bad).toEqual({ ok: false, error: "That value does not fit this property." });
    const good = await actions.setTaskValue(id(1), id(20), { type: "select", optionId: id(21) });
    expect(good).toEqual({ ok: true, value: { type: "select", optionId: id(21) } });
    const upsert = calls.find((c) => used(c, "upsert")) as Call;
    expect(argsOf(upsert, "upsert")?.[0]).toMatchObject({ task_id: id(1), property_id: id(20), option_ids: [id(21)], text_value: null });
  });

  it("counts usage of a property or an option", async () => {
    setup((c) => ({ count: used(c, "contains") ? 2 : 1 }));
    expect(await actions.propertyUsage(id(21))).toEqual({ ok: true, value: 3 });
  });
});
