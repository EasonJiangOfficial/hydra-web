import { verticalCompactor } from "react-grid-layout/core";
import { z } from "zod";

/** Dashboard grid model (DESIGN.md section 6 item 1). Pure: no React, no database. */

export const BREAKPOINTS = ["desktop", "phone"] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

/** 12 columns with 20 px gaps on desktop; 2 columns on the phone. Row heights are in px. */
export const GRID = {
  desktop: { cols: 12, rowHeight: 42, gap: 20 },
  phone: { cols: 2, rowHeight: 56, gap: 12 },
} as const satisfies Record<Breakpoint, { cols: number; rowHeight: number; gap: number }>;

export type Cell = { x: number; y: number; w: number; h: number };
export type Limits = { minW: number; minH: number; maxW: number; maxH: number };
/** Start position and size, plus the size limits, for one block at one breakpoint. `hidden`: off by default there (Add block shows it). */
export type SizeSpec = Cell & Limits & { hidden?: boolean };

/** What the grid knows about a block type without its component. U6 fills the list. */
export type BlockSpec = { id: string; title: string; sizes: Record<Breakpoint, SizeSpec> };

/** One block in a saved layout. A removed block keeps `hidden: true` so it does not come back as "missing". */
export type Item = Cell & { id: string; hidden?: boolean };

export const MAX_ITEMS = 64;
export const itemSchema = z.object({
  id: z.string().min(1).max(64),
  x: z.number().int().min(0).max(1000),
  y: z.number().int().min(0).max(10000),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(100),
  hidden: z.boolean().optional(),
});
export const itemsSchema = z.array(itemSchema).max(MAX_ITEMS);

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

const fromSpec = (s: BlockSpec, bp: Breakpoint): Item => {
  const { x, y, w, h, hidden } = s.sizes[bp];
  return hidden ? { id: s.id, x, y, w, h, hidden } : { id: s.id, x, y, w, h };
};

/** Compact the visible items upward (what the grid does) and leave hidden ones alone. */
export function settle(items: readonly Item[], bp: Breakpoint): Item[] {
  const shown = items.filter((i) => !i.hidden);
  const packed = verticalCompactor.compact(
    shown.map((i) => ({ i: i.id, x: i.x, y: i.y, w: i.w, h: i.h })),
    GRID[bp].cols,
  );
  const at = new Map(packed.map((p) => [p.i, p]));
  return items.map((i) => {
    const p = at.get(i.id);
    return p ? { ...i, x: p.x, y: p.y, w: p.w, h: p.h } : i;
  });
}

/** The wireframe layout: every block at its start position, visible unless its spec hides it at this breakpoint. */
export function defaultItems(specs: readonly BlockSpec[], bp: Breakpoint): Item[] {
  return settle(
    specs.map((s) => fromSpec(s, bp)),
    bp,
  );
}

/** Clamp a size to the block's limits and the grid, and pull x back inside the columns. */
export function fit(item: Item, spec: BlockSpec, bp: Breakpoint): Item {
  const { cols } = GRID[bp];
  const lim = spec.sizes[bp];
  const w = clamp(item.w, lim.minW, Math.min(lim.maxW, cols));
  const h = clamp(item.h, lim.minH, lim.maxH);
  return { ...item, w, h, x: clamp(item.x, 0, cols - w) };
}

/**
 * Turn whatever was saved into a full, valid layout for this registry.
 * Unknown ids and repeats are dropped, bad entries and missing blocks fall back to their default,
 * sizes are clamped to each block's limits.
 */
export function normalizeItems(saved: unknown, specs: readonly BlockSpec[], bp: Breakpoint): Item[] {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const kept = new Map<string, Item>();
  if (Array.isArray(saved)) {
    for (const raw of saved) {
      const parsed = itemSchema.safeParse(raw);
      if (!parsed.success) continue;
      const spec = byId.get(parsed.data.id);
      if (!spec || kept.has(spec.id)) continue;
      kept.set(spec.id, fit(parsed.data, spec, bp));
    }
  }
  return settle(
    specs.map((s) => kept.get(s.id) ?? fromSpec(s, bp)),
    bp,
  );
}

export const visibleItems = (items: readonly Item[]) => items.filter((i) => !i.hidden);

/**
 * What the data asks of one block: `false` leaves it out, a size draws it at that size, undefined keeps it.
 * `list`: the height fits a list's content, so it yields to a height the owner set in Edit. `even`: such a list
 * block with rows; two of them that share a row of the shown layout both take the taller height.
 */
export type Fit = false | { w?: number; h?: number; even?: boolean; list?: boolean } | undefined;

/**
 * The shown layout for this data, or null when nothing changes. Left-out blocks go; the blocks that start on
 * the same row share its columns in proportion to their widths, so the row has no hole; the rest packs up.
 * `baseH` gives a block's default height: an `even` fit applies only while the block is at it (the owner never
 * resized it). Pure display: the saved layout stays as it is.
 */
export function fitItems(
  items: readonly Item[],
  fitOf: (id: string) => Fit,
  bp: Breakpoint,
  baseH?: (id: string) => number | undefined,
): Item[] | null {
  const cols = GRID[bp].cols;
  const fits = new Map(items.map((i) => [i.id, fitOf(i.id)]));
  const out = (i: Item) => fits.get(i.id) === false;
  const spread = new Map<string, { x: number; w: number }>();
  for (const y of new Set(items.filter(out).map((i) => i.y))) {
    const row = items.filter((i) => i.y === y);
    const kept = row.filter((i) => !out(i)).sort((a, b) => a.x - b.x);
    if (!kept.length) continue;
    const from = Math.min(...row.map((i) => i.x));
    const to = Math.max(...row.map((i) => i.x + i.w));
    const sum = kept.reduce((a, i) => a + i.w, 0);
    let x = from;
    kept.forEach((i, n) => {
      const w = n === kept.length - 1 ? to - x : Math.max(1, Math.round((i.w * (to - from)) / sum));
      spread.set(i.id, { x, w });
      x += w;
    });
  }
  let changed = items.some(out);
  const even = new Set<string>();
  const shown = items.filter((i) => !out(i)).map((i) => {
    const f = fits.get(i.id) || {};
    // A height the owner set in Edit wins over a content fit.
    const owned = (f.list || f.even) && baseH && i.h !== baseH(i.id);
    if (f.even && !owned) even.add(i.id);
    const at = spread.get(i.id) ?? { x: i.x, w: i.w };
    const w = Math.min(f.w ?? at.w, cols);
    const h = (owned ? undefined : f.h) ?? i.h;
    const x = Math.min(at.x, cols - w);
    if (w !== i.w || h !== i.h || x !== i.x) changed = true;
    return { ...i, x, w, h };
  });
  const packed = settle(shown, bp);
  // Content-fitted blocks that really share a row (same y once packed) take the taller height, so the row is even.
  const tall = new Map<number, number>();
  for (const i of packed) if (even.has(i.id)) tall.set(i.y, Math.max(tall.get(i.y) ?? 0, i.h));
  let raised = false;
  const evened = packed.map((i) => {
    const h = even.has(i.id) ? tall.get(i.y)! : i.h;
    if (h === i.h) return i;
    raised = true;
    return { ...i, h };
  });
  if (raised) return settle(evened, bp);
  return changed ? packed : null;
}

/** Remove: hide, keep the data. */
export const hideItem = (items: readonly Item[], id: string): Item[] =>
  items.map((i) => (i.id === id ? { ...i, hidden: true } : i));

/** Add block: show it at the left edge below the others, at its default size. */
export function showItem(items: readonly Item[], id: string, specs: readonly BlockSpec[], bp: Breakpoint): Item[] {
  const spec = specs.find((s) => s.id === id);
  if (!spec) return [...items];
  const bottom = visibleItems(items).reduce((m, i) => Math.max(m, i.y + i.h), 0);
  const base = fromSpec(spec, bp);
  return settle(
    items.map((i) => (i.id === id ? { id, x: 0, y: bottom, w: base.w, h: base.h } : i)),
    bp,
  );
}

/** Take the grid's positions for the visible blocks; keep hidden blocks as they were. */
export function applyGrid(
  items: readonly Item[],
  grid: readonly { i: string; x: number; y: number; w: number; h: number }[],
): Item[] {
  const at = new Map(grid.map((g) => [g.i, g]));
  return items.map((i) => {
    const g = at.get(i.id);
    return g && !i.hidden ? { ...i, x: g.x, y: g.y, w: g.w, h: g.h } : i;
  });
}

const key = (i: Item) => `${i.id}:${i.x}:${i.y}:${i.w}:${i.h}:${i.hidden ? 1 : 0}`;
export const sameItems = (a: readonly Item[], b: readonly Item[]) =>
  a.length === b.length && [...a].map(key).sort().join("|") === [...b].map(key).sort().join("|");
