import { describe, expect, it } from "vitest";

import { containerOf, dropAt, moveAcross, rebase } from "./board-drag";

const base = { todo: ["a", "b", "c"], doing: ["d", "e"], done: [] as string[] };

describe("board drag", () => {
  it("finds the column of a card or a column", () => {
    expect(containerOf(base, "e")).toBe("doing");
    expect(containerOf(base, "done")).toBe("done");
    expect(containerOf(base, "zz")).toBeUndefined();
  });

  it("opens a slot above or below the card under the pointer in another column", () => {
    expect(moveAcross(base, "a", "e", false)).toEqual({ todo: ["b", "c"], doing: ["d", "a", "e"], done: [] });
    expect(moveAcross(base, "a", "e", true)).toEqual({ todo: ["b", "c"], doing: ["d", "e", "a"], done: [] });
    expect(moveAcross(base, "a", "done", false)).toEqual({ todo: ["b", "c"], doing: ["d", "e"], done: ["a"] });
  });

  it("keeps the same columns inside one column", () => {
    expect(moveAcross(base, "a", "c", false)).toBe(base);
  });

  it("drops into the open slot of another column", () => {
    const live = moveAcross(base, "a", "e", false);
    expect(dropAt(base, live, "a", "a")).toEqual({ columnId: "doing", afterId: "d", beforeId: "e" });
    expect(dropAt(base, live, "a", "doing")).toEqual({ columnId: "doing", afterId: "e", beforeId: null });
  });

  it("reorders inside a column", () => {
    expect(dropAt(base, base, "a", "c")).toEqual({ columnId: "todo", afterId: "c", beforeId: null });
    expect(dropAt(base, base, "c", "a")).toEqual({ columnId: "todo", afterId: null, beforeId: "a" });
  });

  it("is null when the card ends where it started", () => {
    expect(dropAt(base, base, "b", "b")).toBeNull();
    // Out to another column and back again.
    const back = moveAcross(moveAcross(base, "b", "d", false), "b", "c", false);
    expect(dropAt(base, back, "b", "b")).toBeNull();
  });

  it("keeps the held slot when the store changes under it (a rollback lands mid-drag)", () => {
    // "a" is held in "doing" between d and e; meanwhile "d" rolls back to "todo".
    const live = moveAcross(base, "a", "e", false);
    const now = { todo: ["a", "b", "c", "d"], doing: ["e"], done: [] as string[] };
    const slots = rebase(now, live, "a");
    expect(slots).toEqual({ todo: ["b", "c", "d"], doing: ["a", "e"], done: [] });
    expect(dropAt(now, slots, "a", "a")).toEqual({ columnId: "doing", afterId: null, beforeId: "e" });
    // Nothing changed: the same slots.
    expect(rebase(base, live, "a")).toEqual(live);
  });
});
