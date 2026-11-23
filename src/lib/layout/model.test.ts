import { describe, expect, it } from "vitest";
import { DASHBOARD_BLOCKS } from "./blocks";
import {
  GRID,
  applyGrid,
  defaultItems,
  fitItems,
  hideItem,
  normalizeItems,
  sameItems,
  showItem,
  visibleItems,
  type Breakpoint,
  type Item,
} from "./model";

const ids = DASHBOARD_BLOCKS.map((b) => b.id);
const at = (items: Item[], id: string) => items.find((i) => i.id === id)!;
const overlap = (a: Item, b: Item) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const noOverlap = (items: Item[]) =>
  visibleItems(items).every((a, n, all) => all.slice(n + 1).every((b) => !overlap(a, b)));

describe.each<Breakpoint>(["desktop", "phone"])("default layout, %s", (bp) => {
  const items = defaultItems(DASHBOARD_BLOCKS, bp);
  it("holds every block once, visible unless its spec starts it hidden, inside the columns, without overlap", () => {
    expect(items.map((i) => i.id).sort()).toEqual([...ids].sort());
    for (const b of DASHBOARD_BLOCKS) expect(Boolean(at(items, b.id).hidden)).toBe(Boolean(b.sizes[bp].hidden));
    expect(items.every((i) => i.x >= 0 && i.x + i.w <= GRID[bp].cols)).toBe(true);
    expect(noOverlap(items)).toBe(true);
  });
  it("starts every block inside its own limits", () => {
    for (const b of DASHBOARD_BLOCKS) {
      const s = b.sizes[bp];
      const i = at(items, b.id);
      expect(i.w).toBeGreaterThanOrEqual(s.minW);
      expect(i.w).toBeLessThanOrEqual(s.maxW);
      expect(i.h).toBeGreaterThanOrEqual(s.minH);
      expect(i.h).toBeLessThanOrEqual(s.maxH);
    }
  });
});

describe("default layouts follow the wireframes", () => {
  it("desktop: net worth 8 wide beside cash and cards 4 wide, then the month strip full width", () => {
    const d = defaultItems(DASHBOARD_BLOCKS, "desktop");
    expect(at(d, "net-worth")).toMatchObject({ x: 0, y: 0, w: 8 });
    expect(at(d, "accounts")).toMatchObject({ x: 8, y: 0, w: 4 });
    expect(at(d, "month")).toMatchObject({ x: 0, w: 12 });
    expect(["ugc", "posting", "recent"].map((id) => at(d, id).w)).toEqual([4, 4, 4]);
    expect(["goals", "coming-up"].map((id) => at(d, id).w)).toEqual([6, 6]);
  });
  it("desktop: the phone's summary tiles start hidden", () => {
    const d = defaultItems(DASHBOARD_BLOCKS, "desktop");
    expect(visibleItems(d).map((i) => i.id)).not.toContain("summary");
  });
  it("phone: Mobile.dc.html order, one column of full-width blocks; the full cash, month and UGC cards start hidden", () => {
    const p = defaultItems(DASHBOARD_BLOCKS, "phone");
    expect(at(p, "net-worth")).toMatchObject({ x: 0, y: 0, w: 2 });
    expect(p.every((i) => i.x === 0 && i.w === 2)).toBe(true);
    const order = [...visibleItems(p)].sort((a, b) => a.y - b.y).map((i) => i.id);
    // Income and expenses sits right after net worth (owner, 2026-11-22: the scope switch must change the charts).
    expect(order).toEqual(["net-worth", "income-expenses", "summary", "posting", "recent", "goals", "coming-up"]);
    expect(p.filter((i) => i.hidden).map((i) => i.id).sort()).toEqual(["accounts", "month", "ugc"]);
  });
  it("desktop: income and expenses full width right under net worth and cash and cards", () => {
    const d = defaultItems(DASHBOARD_BLOCKS, "desktop");
    expect(at(d, "income-expenses")).toMatchObject({ x: 0, y: 6, w: 12 });
    expect(at(d, "month").y).toBeGreaterThan(at(d, "income-expenses").y);
  });
  it("a saved layout from before a block existed gets that block at its default, hidden where the spec hides it", () => {
    const old = defaultItems(DASHBOARD_BLOCKS, "desktop").filter((i) => i.id !== "summary");
    expect(at(normalizeItems(old, DASHBOARD_BLOCKS, "desktop"), "summary").hidden).toBe(true);
  });
});

describe("normalizeItems", () => {
  it("returns the default for nothing saved", () => {
    for (const saved of [null, undefined, [], "x", 5, {}]) {
      expect(normalizeItems(saved, DASHBOARD_BLOCKS, "desktop")).toEqual(defaultItems(DASHBOARD_BLOCKS, "desktop"));
    }
  });

  it("drops unknown ids", () => {
    const saved = [{ id: "ghost", x: 0, y: 0, w: 4, h: 4 }, ...defaultItems(DASHBOARD_BLOCKS, "desktop")];
    const out = normalizeItems(saved, DASHBOARD_BLOCKS, "desktop");
    expect(out.map((i) => i.id)).not.toContain("ghost");
    expect(out).toHaveLength(ids.length);
  });

  it("falls back to the default for a block missing from the save, without overlap", () => {
    const saved = defaultItems(DASHBOARD_BLOCKS, "desktop").filter((i) => i.id !== "goals");
    const out = normalizeItems(saved, DASHBOARD_BLOCKS, "desktop");
    expect(at(out, "goals")).toMatchObject({ w: 6, h: 4 });
    expect(at(out, "goals").hidden).toBeUndefined();
    expect(noOverlap(out)).toBe(true);
  });

  it("keeps a removed block removed", () => {
    const saved = hideItem(defaultItems(DASHBOARD_BLOCKS, "desktop"), "recent");
    const out = normalizeItems(saved, DASHBOARD_BLOCKS, "desktop");
    expect(at(out, "recent").hidden).toBe(true);
    expect(visibleItems(out)).toHaveLength(visibleItems(defaultItems(DASHBOARD_BLOCKS, "desktop")).length - 1);
  });

  it("clamps sizes to each block's min and max and keeps x inside the columns", () => {
    const saved: Item[] = [
      { id: "net-worth", x: 11, y: 0, w: 12, h: 1 },
      { id: "posting", x: 10, y: 0, w: 1, h: 100 },
    ];
    const out = normalizeItems(saved, DASHBOARD_BLOCKS, "desktop");
    const nw = DASHBOARD_BLOCKS[0].sizes.desktop;
    expect(at(out, "net-worth").w).toBe(12);
    expect(at(out, "net-worth").h).toBe(nw.minH);
    const po = DASHBOARD_BLOCKS.find((b) => b.id === "posting")!.sizes.desktop;
    expect(at(out, "posting").w).toBe(po.minW);
    expect(at(out, "posting").h).toBe(po.maxH);
    expect(out.every((i) => i.x + i.w <= 12)).toBe(true);
    expect(noOverlap(out)).toBe(true);
  });

  it("never lets a phone block pass 2 columns or fall under its minimum", () => {
    const saved: Item[] = [
      { id: "net-worth", x: 1, y: 0, w: 1, h: 4 },
      { id: "ugc", x: 0, y: 4, w: 9, h: 4 },
    ];
    const out = normalizeItems(saved, DASHBOARD_BLOCKS, "phone");
    expect(at(out, "net-worth")).toMatchObject({ x: 0, w: 2 });
    expect(at(out, "ugc").w).toBe(2);
    expect(out.every((i) => i.x + i.w <= 2)).toBe(true);
  });

  it("skips malformed entries and duplicates", () => {
    const good = { id: "recent", x: 0, y: 0, w: 4, h: 5 };
    const saved = [good, { ...good, x: 4 }, { id: "ugc", x: "a" }, null, 7, { id: "goals", x: 0.5, y: 0, w: 6, h: 4 }];
    const out = normalizeItems(saved, DASHBOARD_BLOCKS, "desktop");
    expect(out.filter((i) => i.id === "recent")).toHaveLength(1);
    expect(at(out, "ugc")).toMatchObject({ w: 4, h: 5 });
    expect(at(out, "goals")).toMatchObject({ w: 6, h: 4 });
    expect(out).toHaveLength(ids.length);
  });

  it("is stable: normalizing a normalized layout changes nothing", () => {
    for (const bp of ["desktop", "phone"] as const) {
      const once = normalizeItems(hideItem(defaultItems(DASHBOARD_BLOCKS, bp), "posting"), DASHBOARD_BLOCKS, bp);
      expect(sameItems(normalizeItems(once, DASHBOARD_BLOCKS, bp), once)).toBe(true);
    }
  });
});

describe("remove and add", () => {
  it("hides without losing the block, then shows it at the bottom at its default size", () => {
    const start = defaultItems(DASHBOARD_BLOCKS, "desktop");
    const hidden = hideItem(start, "posting");
    expect(at(hidden, "posting").hidden).toBe(true);
    const back = showItem(hidden, "posting", DASHBOARD_BLOCKS, "desktop");
    const p = at(back, "posting");
    expect(p.hidden).toBeUndefined();
    expect(p).toMatchObject({ x: 0, w: 4, h: 5 });
    expect(noOverlap(back)).toBe(true);
  });

  it("ignores an id that is not in the registry", () => {
    const start = defaultItems(DASHBOARD_BLOCKS, "phone");
    expect(showItem(start, "ghost", DASHBOARD_BLOCKS, "phone")).toEqual(start);
  });
});

describe("applyGrid and sameItems", () => {
  it("moves visible blocks to the grid's positions and leaves hidden ones", () => {
    const start = hideItem(defaultItems(DASHBOARD_BLOCKS, "desktop"), "goals");
    const out = applyGrid(start, [
      { i: "recent", x: 0, y: 99, w: 5, h: 3 },
      { i: "goals", x: 3, y: 3, w: 3, h: 3 },
    ]);
    expect(at(out, "recent")).toMatchObject({ x: 0, y: 99, w: 5, h: 3 });
    expect(at(out, "goals")).toEqual(at(start, "goals"));
  });

  it("compares layouts by content, not order", () => {
    const a = defaultItems(DASHBOARD_BLOCKS, "desktop");
    expect(sameItems(a, [...a].reverse())).toBe(true);
    expect(sameItems(a, hideItem(a, "ugc"))).toBe(false);
  });
});

describe("fitItems: the shown layout for one scope's data", () => {
  const d = visibleItems(defaultItems(DASHBOARD_BLOCKS, "desktop"));
  it("changes nothing when every block keeps its place", () => {
    expect(fitItems(d, () => undefined, "desktop")).toBeNull();
  });
  it("drops left-out blocks, gives their row to the block left on it, and packs the rest up without overlap", () => {
    const out = fitItems(d, (id) => (id === "ugc" || id === "posting" ? false : undefined), "desktop")!;
    expect(out.map((i) => i.id)).not.toContain("ugc");
    expect(out.map((i) => i.id)).not.toContain("posting");
    expect(at(out, "recent")).toMatchObject({ x: 0, w: 12 });
    expect(noOverlap(out)).toBe(true);
  });
  it("a one-row net worth with cash and cards left out spans the row, and the board moves up under it", () => {
    const out = fitItems(d, (id) => (id === "accounts" ? false : id === "net-worth" ? { h: 1 } : undefined), "desktop")!;
    expect(at(out, "net-worth")).toMatchObject({ x: 0, y: 0, w: 12, h: 1 });
    expect(at(out, "income-expenses").y).toBe(1);
    expect(noOverlap(out)).toBe(true);
  });
  it("evens content-fitted blocks only when they really share a row, and only up", () => {
    const fits = (h: Record<string, number>, plain: string[] = []) => (id: string) =>
      id in h ? { h: h[id], even: !plain.includes(id) } : undefined;
    const base = (id: string) => DASHBOARD_BLOCKS.find((b) => b.id === id)!.sizes.desktop.h;
    // Goals and Coming up side by side: the shorter takes the taller height.
    const row = fitItems(d, fits({ goals: 4, "coming-up": 3 }), "desktop", base)!;
    expect([at(row, "goals").h, at(row, "coming-up").h]).toEqual([4, 4]);
    expect(at(row, "goals").y).toBe(at(row, "coming-up").y);
    // An empty list (a fit without `even`) keeps its own height and never raises its neighbor.
    const empty = fitItems(d, fits({ goals: 3, "coming-up": 5 }, ["goals"]), "desktop", base)!;
    expect([at(empty, "goals").h, at(empty, "coming-up").h]).toEqual([3, 5]);
    // A tall Recent pushes Coming up below Goals: they no longer share a row, so neither is raised.
    const apart = fitItems(d, fits({ recent: 7, goals: 4, "coming-up": 3 }), "desktop", base)!;
    expect(at(apart, "goals").y).not.toBe(at(apart, "coming-up").y);
    expect([at(apart, "goals").h, at(apart, "coming-up").h]).toEqual([4, 3]);
    expect(noOverlap(apart)).toBe(true);
    // A height the owner set in Edit wins over the fit, and that block is not evened.
    const owned = d.map((i) => (i.id === "goals" ? { ...i, h: 6 } : i));
    const kept = fitItems(owned, fits({ goals: 4, "coming-up": 3 }), "desktop", base)!;
    expect([at(kept, "goals").h, at(kept, "coming-up").h]).toEqual([6, 3]);
    // An empty list's fit (no rows, so not evened) also yields to a height the owner set.
    const ownedEmpty = fitItems(owned, (id) => (id === "goals" ? { h: 2, list: true } : undefined), "desktop", base);
    expect(ownedEmpty === null || at(ownedEmpty, "goals").h === 6).toBe(true);
  });
  it("never touches the items it was given", () => {
    const before = JSON.stringify(d);
    fitItems(d, (id) => (id === "recent" ? false : undefined), "desktop");
    expect(JSON.stringify(d)).toBe(before);
  });
});
