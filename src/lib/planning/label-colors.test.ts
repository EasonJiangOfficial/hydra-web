import { beforeEach, describe, expect, it, vi } from "vitest";

import * as actions from "./actions";
import { fixtureSnapshot, id } from "./fixtures";
import { createMemoryActions } from "./memory-actions";
import { PlanningError } from "./result";
import { ownerCtx } from "./server";
import { argsOf, fakeDb, type Call, type Reply } from "./test-db";

vi.mock("./server", () => ({ ownerCtx: vi.fn() }));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/lib/google/calendar", () => ({ pushToGoogle: vi.fn(), removeFromGoogle: vi.fn() }));

function setup(reply: (call: Call) => Reply) {
  const { db, calls } = fakeDb(reply);
  vi.mocked(ownerCtx).mockResolvedValue({ db, now: () => new Date("2026-11-21T15:00:00Z"), timeZone: async () => "America/Toronto" });
  return calls;
}

beforeEach(() => {
  vi.mocked(ownerCtx).mockReset();
});

describe("saving a label color", () => {
  it("a status color writes the color column of that status", async () => {
    const calls = setup(() => ({ data: { id: id(2), label: "Blocked", color: "#c0687a", position: 0, is_done: false, created_at: "" } }));
    const r = await actions.updateStatus(id(2), { color: "#c0687a" });
    expect(r).toMatchObject({ ok: true, value: { id: id(2), color: "#c0687a" } });
    expect(calls[0].table).toBe("planning_statuses");
    expect(argsOf(calls[0], "update")).toEqual([{ color: "#c0687a" }]);
    expect(argsOf(calls[0], "eq")).toEqual(["id", id(2)]);
  });

  it("an option color writes the color column of that option", async () => {
    const calls = setup(() => ({ data: { id: id(3), property_id: id(4), label: "Urgent", color: "#4f7cb8", position: 0 } }));
    const r = await actions.updateOption(id(3), { color: "#4f7cb8" });
    expect(r).toMatchObject({ ok: true, value: { id: id(3), color: "#4f7cb8" } });
    expect(calls[0].table).toBe("planning_property_options");
    expect(argsOf(calls[0], "update")).toEqual([{ color: "#4f7cb8" }]);
  });

  it("refuses a color that is not #rrggbb, before any write", async () => {
    const calls = setup(() => ({ data: null }));
    for (const color of ["red", "#abc", "#12345g", "url(x)"]) {
      expect(await actions.updateStatus(id(2), { color })).toMatchObject({ ok: false });
      expect(await actions.updateOption(id(3), { color })).toMatchObject({ ok: false });
    }
    // The chain is started, but validation throws while building update(), so no write is sent.
    expect(calls.filter((c) => c.ops.some(([op]) => op === "update"))).toHaveLength(0);
  });

  it("only the owner can recolor", async () => {
    vi.mocked(ownerCtx).mockImplementation(async () => {
      throw new PlanningError("Not allowed.");
    });
    expect(await actions.updateStatus(id(2), { color: "#c0687a" })).toEqual({ ok: false, error: "Not allowed." });
    expect(await actions.updateOption(id(3), { color: "#c0687a" })).toEqual({ ok: false, error: "Not allowed." });
  });

  it("the memory actions (the /dev pages) keep a new color", async () => {
    const mem = createMemoryActions(fixtureSnapshot(new Date("2026-11-21T15:00:00Z")));
    const status = mem.snapshot().statuses[0];
    expect(await mem.actions.updateStatus(status.id, { color: "#4b8a8c" })).toMatchObject({ ok: true, value: { color: "#4b8a8c" } });
    expect(mem.snapshot().statuses.find((s) => s.id === status.id)?.color).toBe("#4b8a8c");
    const prop = mem.snapshot().properties.find((p) => p.options.length > 0)!;
    const option = prop.options[0];
    expect(await mem.actions.updateOption(option.id, { color: "#8466ae" })).toMatchObject({ ok: true });
    expect(mem.snapshot().properties.find((p) => p.id === prop.id)?.options.find((o) => o.id === option.id)?.color).toBe("#8466ae");
    expect(await mem.actions.updateOption(option.id, { color: "purple" })).toMatchObject({ ok: false });
  });
});

describe("saving a category color", () => {
  it("upserts the category's row, lowercased", async () => {
    const calls = setup(() => ({ data: null }));
    const r = await actions.setCategoryColor(" UGC ", "#4F7CB8");
    expect(r).toEqual({ ok: true, value: { category: "UGC", color: "#4f7cb8" } });
    expect(calls[0].table).toBe("planning_category_colors");
    const [row, opts] = argsOf(calls[0], "upsert") as [Record<string, unknown>, unknown];
    expect(row).toMatchObject({ category: "UGC", color: "#4f7cb8" });
    expect(opts).toEqual({ onConflict: "category" });
  });

  it("a null color deletes the row", async () => {
    const calls = setup(() => ({ data: null }));
    expect(await actions.setCategoryColor("UGC", null)).toEqual({ ok: true, value: { category: "UGC", color: null } });
    expect(calls[0].table).toBe("planning_category_colors");
    expect(calls[0].ops.some(([op]) => op === "delete")).toBe(true);
    expect(argsOf(calls[0], "eq")).toEqual(["category", "UGC"]);
  });

  it("refuses a bad color or a blank category before any write, and a non-owner", async () => {
    const calls = setup(() => ({ data: null }));
    for (const [c, color] of [["UGC", "red"], ["UGC", "#abc"], ["  ", "#4f7cb8"]] as const) {
      expect(await actions.setCategoryColor(c, color)).toMatchObject({ ok: false });
    }
    expect(calls).toHaveLength(0);
    vi.mocked(ownerCtx).mockImplementation(async () => {
      throw new PlanningError("Not allowed.");
    });
    expect(await actions.setCategoryColor("UGC", "#4f7cb8")).toEqual({ ok: false, error: "Not allowed." });
  });

  it("colors a Category column of the board and its own keys only", async () => {
    const { buildColumns } = await import("./board");
    const { categoryColorOf } = await import("./tasks");
    const snap = { ...fixtureSnapshot(new Date("2026-11-21T15:00:00Z")), categoryColors: { UGC: "#4f7cb8" } };
    const cols = buildColumns(snap, snap.tasks, { kind: "category" }, { key: "manual", dir: "asc" });
    expect(cols.find((c) => c.id === "UGC")?.color).toBe("#4f7cb8");
    expect(cols.find((c) => c.id === "Taxes")?.color).toBeNull();
    expect(categoryColorOf(snap, "constructor")).toBeNull();
    expect(categoryColorOf({}, "UGC")).toBeNull();
    const { withCategoryColor } = await import("./tasks");
    const odd = withCategoryColor({ UGC: "#4f7cb8" }, "__proto__", "#c29a2e");
    expect(Object.getPrototypeOf(odd)).toBe(Object.prototype);
    expect(categoryColorOf({ categoryColors: odd }, "__proto__")).toBe("#c29a2e");
    expect(withCategoryColor(odd, "UGC", null)).toEqual(withCategoryColor({}, "__proto__", "#c29a2e"));
  });
});
