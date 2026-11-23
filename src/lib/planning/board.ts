import { moveItem } from "./ordering";
import type { PlanningProperty, PropertyValue } from "./properties";
import type { TaskPatch } from "./schemas";
import { categoriesOf, categoryColorOf, sortTasks, tasksInStatus } from "./tasks";
import { sortGoals } from "./goals";
import type { BoardGroupBy, PlanningSnapshot, PlanningTask, TaskSortSpec } from "./types";

/** The id of the "No <group>" column. */
export const NO_VALUE_COLUMN = "none";

export type GroupMode =
  | { readonly kind: "status" }
  | { readonly kind: "category" }
  | { readonly kind: "goal" }
  | { readonly kind: "property"; readonly property: PlanningProperty };

/** "status" | "category" | "goal" | "prop:<select property id>". Anything unknown is status. */
export function groupModeOf(groupBy: BoardGroupBy, snapshot: Pick<PlanningSnapshot, "properties">): GroupMode {
  if (groupBy === "category") return { kind: "category" };
  if (groupBy === "goal") return { kind: "goal" };
  if (groupBy.startsWith("prop:")) {
    const property = snapshot.properties.find((p) => `prop:${p.id}` === groupBy && p.type === "select");
    if (property) return { kind: "property", property };
  }
  return { kind: "status" };
}

/** One board column, whatever it groups by. */
export interface ColumnModel {
  /** A status id, a category, a goal id, an option id, or NO_VALUE_COLUMN. */
  readonly id: string;
  readonly label: string;
  /** The dot beside the name; null draws none. */
  readonly color: string | null;
  readonly tasks: readonly PlanningTask[];
}

const GRAY = "#c7c7cc";

/**
 * The columns: one per status, or one per category, goal or option of a select property with a
 * "No <group>" column first. `sort` orders each column; manual is position order. A task whose
 * category, goal or option is gone sits in "No <group>".
 */
export function buildColumns(
  snapshot: PlanningSnapshot,
  tasks: readonly PlanningTask[],
  mode: GroupMode,
  sort: TaskSortSpec,
): ColumnModel[] {
  const { statuses, properties, goals } = snapshot;
  const order = (list: readonly PlanningTask[]): readonly PlanningTask[] =>
    sort.key === "manual" ? list : sortTasks(list, sort, statuses, { properties });
  // Position order is per status, so across statuses it is only a stable tie-break.
  const byPosition = [...tasks].sort((a, b) => a.position - b.position);

  if (mode.kind === "status") {
    return statuses.map((s) => ({ id: s.id, label: s.label, color: s.color, tasks: order(tasksInStatus(tasks, s.id)) }));
  }
  if (mode.kind === "category") {
    const known = categoriesOf(snapshot);
    return [
      { id: NO_VALUE_COLUMN, label: "No category", color: GRAY, tasks: order(byPosition.filter((t) => t.category === null)) },
      ...known.map((c) => ({ id: c, label: c, color: categoryColorOf(snapshot, c), tasks: order(byPosition.filter((t) => t.category === c)) })),
    ];
  }
  if (mode.kind === "goal") {
    return [
      { id: NO_VALUE_COLUMN, label: "No goal", color: GRAY, tasks: order(byPosition.filter((t) => t.goalId === null || !goals.some((g) => g.id === t.goalId))) },
      ...sortGoals(goals).map((g) => ({ id: g.id, label: g.title, color: null, tasks: order(byPosition.filter((t) => t.goalId === g.id)) })),
    ];
  }
  const { property } = mode;
  const optionOf = (t: PlanningTask): string | null => {
    const v = t.values[property.id];
    return v?.type === "select" && property.options.some((o) => o.id === v.optionId) ? v.optionId : null;
  };
  return [
    { id: NO_VALUE_COLUMN, label: `No ${property.name}`, color: GRAY, tasks: order(byPosition.filter((t) => optionOf(t) === null)) },
    ...property.options.map((o) => ({ id: o.id, label: o.label, color: o.color, tasks: order(byPosition.filter((t) => optionOf(t) === o.id)) })),
  ];
}

export interface DropTarget {
  readonly columnId: string;
  readonly afterId: string | null;
  readonly beforeId: string | null;
}

/**
 * Where a dragged card lands. `overId` is a task id (lands in that card's slot) or a column id
 * (lands at the end of that column). Returns the moved card's visible neighbours, or null when
 * nothing changes.
 */
export function resolveDrop(
  columns: Readonly<Record<string, readonly string[]>>,
  activeId: string,
  overId: string,
): DropTarget | null {
  if (activeId === overId) return null;
  const ids = Object.keys(columns);
  const from = ids.find((id) => columns[id].includes(activeId));
  const overColumn = ids.includes(overId);
  const to = overColumn ? overId : ids.find((id) => columns[id].includes(overId));
  if (from === undefined || to === undefined) return null;

  let next: string[];
  if (from === to) {
    const source = columns[from];
    const at = source.indexOf(activeId);
    const target = overColumn ? source.length - 1 : source.indexOf(overId);
    if (at === target) return null;
    next = moveItem(source, at, target);
  } else {
    const rest = columns[to].filter((id) => id !== activeId);
    const slot = overColumn ? rest.length : rest.indexOf(overId);
    next = [...rest.slice(0, slot), activeId, ...rest.slice(slot)];
  }
  const i = next.indexOf(activeId);
  return { columnId: to, afterId: next[i - 1] ?? null, beforeId: next[i + 1] ?? null };
}

/**
 * What putting a task in `columnId` of a grouped board changes: a task patch (category, goal), a
 * property value (select option, or null to clear), or nothing (status moves use positions).
 */
export function assignmentFor(
  mode: GroupMode,
  columnId: string,
): { patch?: TaskPatch; propertyId?: string; value?: PropertyValue | null } {
  const none = columnId === NO_VALUE_COLUMN;
  switch (mode.kind) {
    case "status":
      return {};
    case "category":
      return { patch: { category: none ? null : columnId } };
    case "goal":
      return { patch: { goalId: none ? null : columnId } };
    case "property":
      return { propertyId: mode.property.id, value: none ? null : { type: "select", optionId: columnId } };
  }
}
