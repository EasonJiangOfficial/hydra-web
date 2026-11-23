import { describe, expect, it } from "vitest";
import { canUndoHere, groupActivity, runsOf, whenWhere } from "./activity";
import type { Activity } from "./types";

const HERE = "t-here";
const row = (id: string, label: string, more: Partial<Activity> = {}): Activity => ({
  id,
  label,
  undoId: id,
  undone: false,
  createdAt: "2026-11-22T15:04:00Z",
  threadId: HERE,
  surface: "web",
  ...more,
});

describe("the panel's activity groups", () => {
  it("folds only consecutive repeats of one label, newest first kept", () => {
    const rows = [row("1", "Added a rule"), row("2", "Added a rule"), row("3", "Added Coffee"), row("4", "Added a rule")];
    expect(runsOf(rows).map((r) => [r.label, r.rows.map((x) => x.id)])).toEqual([
      ["Added a rule", ["1", "2"]],
      ["Added Coffee", ["3"]],
      ["Added a rule", ["4"]],
    ]);
  });

  it("splits this chat from earlier; with no thread yet everything is earlier", () => {
    const rows = [row("1", "A"), row("2", "B", { threadId: "other" }), row("3", "C", { threadId: null })];
    const g = groupActivity(rows, HERE);
    expect(g.here.map((r) => r.key)).toEqual(["1"]);
    expect(g.earlier.map((r) => r.key)).toEqual(["2", "3"]);
    expect(groupActivity(rows, null).here).toEqual([]);
  });

  it("the header dot: this chat has a change that can still be undone", () => {
    expect(canUndoHere([row("1", "A")], HERE)).toBe(true);
    expect(canUndoHere([row("1", "A", { undoId: null, undone: true })], HERE)).toBe(false);
    expect(canUndoHere([row("1", "A", { threadId: "other" })], HERE)).toBe(false);
    expect(canUndoHere([row("1", "A")], null)).toBe(false);
  });

  it("when and where for the hover, never a blank line", () => {
    expect(whenWhere(row("1", "A", { surface: "phone" }))).toMatch(/Nov 22.* · Phone$/);
    expect(whenWhere({ createdAt: null, surface: "mcp" })).toBe("Outside tool");
    expect(whenWhere({ createdAt: "nope", surface: null })).toBeUndefined();
  });
});
