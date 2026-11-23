import { describe, expect, it } from "vitest";

import { NO_VALUE_COLUMN, assignmentFor, buildColumns, groupModeOf, resolveDrop } from "./board";
import { FX, fixtureSnapshot, id } from "./fixtures";
import { DEFAULT_BOARD_SORT } from "./types";

const snap = fixtureSnapshot(new Date("2026-11-21T15:00:00Z"), "America/Toronto");
const ids = (col: { tasks: readonly { id: string }[] }) => col.tasks.map((t) => t.id);

describe("resolveDrop", () => {
  const cols = { a: ["1", "2", "3"], b: ["4", "5"] };

  it("lands in the slot of the card it is dropped on", () => {
    expect(resolveDrop(cols, "1", "5")).toEqual({ columnId: "b", afterId: "4", beforeId: "5" });
    expect(resolveDrop(cols, "4", "2")).toEqual({ columnId: "a", afterId: "1", beforeId: "2" });
  });

  it("lands at the end of a column dropped on its body", () => {
    expect(resolveDrop(cols, "1", "b")).toEqual({ columnId: "b", afterId: "5", beforeId: null });
    expect(resolveDrop({ a: ["1"], b: [] }, "1", "b")).toEqual({ columnId: "b", afterId: null, beforeId: null });
  });

  it("reorders inside one column and ignores a drop that changes nothing", () => {
    // dragging down onto a card takes that card's slot: it ends up after it
    expect(resolveDrop(cols, "1", "3")).toEqual({ columnId: "a", afterId: "3", beforeId: null });
    expect(resolveDrop(cols, "3", "1")).toEqual({ columnId: "a", afterId: null, beforeId: "1" });
    expect(resolveDrop(cols, "2", "2")).toBeNull();
    expect(resolveDrop(cols, "3", "a")).toBeNull();
    expect(resolveDrop(cols, "9", "a")).toBeNull();
  });
});

describe("board columns", () => {
  it("one column per status, cards in position order", () => {
    const cols = buildColumns(snap, snap.tasks, groupModeOf("status", snap), DEFAULT_BOARD_SORT);
    expect(cols.map((c) => c.label)).toEqual(["Not started", "In progress", "Blocked", "Done"]);
    expect(ids(cols[0])).toEqual([id(100), id(101), id(107)]);
  });

  it("group by category puts uncategorized cards in No category first", () => {
    const withNone = { ...snap, tasks: [...snap.tasks, { ...snap.tasks[0], id: id(150), category: null }] };
    const cols = buildColumns(withNone, withNone.tasks, groupModeOf("category", snap), DEFAULT_BOARD_SORT);
    expect(cols.map((c) => c.label)).toEqual(["No category", "Hydra", "Money", "Taxes", "UGC"]);
    expect(ids(cols[0])).toEqual([id(150)]);
  });

  it("group by goal, and a card whose goal is gone sits in No goal", () => {
    const orphan = { ...snap, tasks: snap.tasks.map((t) => (t.id === id(100) ? { ...t, goalId: id(999) } : t)) };
    const cols = buildColumns(orphan, orphan.tasks, groupModeOf("goal", snap), DEFAULT_BOARD_SORT);
    expect(cols[0].label).toBe("No goal");
    expect(ids(cols[0])).toContain(id(100));
    expect(cols.map((c) => c.label).slice(1)).toEqual(["Post 3 a day", "Taxes ready by January", "Save 30 percent"]);
  });

  it("group by a select property uses its options in order", () => {
    const mode = groupModeOf(`prop:${FX.propPriority}`, snap);
    expect(mode.kind).toBe("property");
    const cols = buildColumns(snap, snap.tasks, mode, DEFAULT_BOARD_SORT);
    expect(cols.map((c) => c.label)).toEqual(["No Priority", "Urgent", "High", "Medium", "Low"]);
    expect(ids(cols[1]).sort()).toEqual([id(103), id(107)]);
  });

  it("an unknown or non-select group falls back to status", () => {
    expect(groupModeOf("prop:nope", snap).kind).toBe("status");
    expect(groupModeOf(`prop:${FX.propEffort}`, snap).kind).toBe("status");
    expect(groupModeOf("whatever", snap).kind).toBe("status");
  });

  it("a sort orders each column", () => {
    const cols = buildColumns(snap, snap.tasks, { kind: "status" }, { key: "title", dir: "asc" });
    expect(ids(cols[0])).toEqual([id(107), id(100), id(101)]); // Call, Film, Send
  });
});

describe("assignmentFor", () => {
  it("says what a drop into a grouped column changes", () => {
    expect(assignmentFor({ kind: "status" }, FX.statusDone)).toEqual({});
    expect(assignmentFor({ kind: "category" }, "Taxes")).toEqual({ patch: { category: "Taxes" } });
    expect(assignmentFor({ kind: "category" }, NO_VALUE_COLUMN)).toEqual({ patch: { category: null } });
    expect(assignmentFor({ kind: "goal" }, FX.goalTax)).toEqual({ patch: { goalId: FX.goalTax } });
    const mode = groupModeOf(`prop:${FX.propPriority}`, snap);
    expect(assignmentFor(mode, FX.optHigh)).toEqual({ propertyId: FX.propPriority, value: { type: "select", optionId: FX.optHigh } });
    expect(assignmentFor(mode, NO_VALUE_COLUMN)).toEqual({ propertyId: FX.propPriority, value: null });
  });
});
