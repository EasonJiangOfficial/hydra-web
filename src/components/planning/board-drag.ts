import { resolveDrop, type DropTarget } from "@/lib/planning/board";

/** Card ids per column id, in screen order. */
export type ColumnIds = Readonly<Record<string, readonly string[]>>;

/** The column that holds `id` (a column id holds itself). */
export function containerOf(cols: ColumnIds, id: string): string | undefined {
  return id in cols ? id : Object.keys(cols).find((c) => cols[c].includes(id));
}

/**
 * Mid-drag: the dragged card's slot jumps to the column under the pointer, so that column opens a
 * gap for it. `overId` is a card (the slot goes above it, or below when `below`) or the column
 * (the slot goes last). Returns the same object when nothing changes.
 */
export function moveAcross(cols: ColumnIds, activeId: string, overId: string, below: boolean): ColumnIds {
  const from = containerOf(cols, activeId);
  const to = containerOf(cols, overId);
  if (!from || !to || from === to) return cols;
  const target = cols[to];
  const at = target.indexOf(overId);
  const slot = at >= 0 ? at + (below ? 1 : 0) : target.length;
  return { ...cols, [from]: cols[from].filter((x) => x !== activeId), [to]: [...target.slice(0, slot), activeId, ...target.slice(slot)] };
}

/**
 * On drop: where the card lands, given the live columns (`live`, with the slot already moved) and
 * the columns before the drag (`base`). Null when the card ends where it started.
 */
export function dropAt(base: ColumnIds, live: ColumnIds, activeId: string, overId: string): DropTarget | null {
  let drop = overId === activeId ? null : resolveDrop(live, activeId, overId);
  if (!drop) {
    const col = containerOf(live, activeId);
    if (!col) return null;
    const i = live[col].indexOf(activeId);
    drop = { columnId: col, afterId: live[col][i - 1] ?? null, beforeId: live[col][i + 1] ?? null };
  }
  const was = containerOf(base, activeId);
  if (was === drop.columnId) {
    const i = base[was].indexOf(activeId);
    if ((base[was][i - 1] ?? null) === drop.afterId && (base[was][i + 1] ?? null) === drop.beforeId) return null;
  }
  return drop;
}

/**
 * Mid-drag, when the store changes under the held card (a rollback lands, another write): the
 * columns as they are now (`base`), with the dragged card's slot kept in the column it is over in
 * `live`, next to the same neighbour when that neighbour is still there.
 */
export function rebase(base: ColumnIds, live: ColumnIds, activeId: string): ColumnIds {
  const to = containerOf(live, activeId);
  if (!to || !(to in base)) return base;
  const out: Record<string, readonly string[]> = {};
  for (const [col, ids] of Object.entries(base)) out[col] = ids.filter((x) => x !== activeId);
  const was = live[to];
  const i = was.indexOf(activeId);
  const rows = out[to];
  const after = i > 0 ? rows.indexOf(was[i - 1]) : -1;
  const before = i + 1 < was.length ? rows.indexOf(was[i + 1]) : -1;
  const slot = after >= 0 ? after + 1 : before >= 0 ? before : i === 0 ? 0 : rows.length;
  out[to] = [...rows.slice(0, slot), activeId, ...rows.slice(slot)];
  return out;
}
