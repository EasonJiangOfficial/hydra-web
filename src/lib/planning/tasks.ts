import { needsRenormalize, positionBetween, renormalize, type PositionUpdate } from "./ordering";
import { comparePropertyValues, matchesPropertyFilter, type PlanningProperty, type PropertyFilter } from "./properties";
import {
  DEFAULT_FILTERS,
  type PlanningFilters,
  type PlanningGoal,
  type PlanningSnapshot,
  type PlanningStatus,
  type PlanningTask,
  type TaskSortSpec,
} from "./types";
import type { TaskPatch } from "./schemas";

/** Keep, set or clear completedAt the way the DB trigger will. */
export function completedAtFor(
  task: PlanningTask,
  statusId: string,
  statuses: readonly PlanningStatus[],
  now: Date,
): string | null {
  const done = (id: string) => statuses.some((s) => s.id === id && s.isDone);
  if (done(task.statusId) === done(statusId)) return task.completedAt;
  return done(statusId) ? now.toISOString() : null;
}

/** The status "complete" moves a task to (first done one), or "reopen" (first not-done one). */
export function statusForDone(statuses: readonly PlanningStatus[], done: boolean): PlanningStatus | undefined {
  return [...statuses].sort(byPosition).find((s) => s.isDone === done);
}

/**
 * Where `id` lands among `rows` (sorted, without `id`): right after afterId, else right before
 * beforeId, else at the end. Neighbours come from these full rows, so a filtered view never
 * collides with a hidden row. When the gap is too small, every row gets a fresh position.
 */
export function placeAmong(
  rows: readonly { readonly id: string; readonly position: number }[],
  id: string,
  afterId: string | null | undefined,
  beforeId: string | null | undefined,
): { position: number; renormalized: PositionUpdate[] | null } {
  const after = afterId ? rows.findIndex((r) => r.id === afterId) : -1;
  const before = beforeId ? rows.findIndex((r) => r.id === beforeId) : -1;
  const index = after >= 0 ? after + 1 : before >= 0 ? before : rows.length;
  const prev = rows[index - 1]?.position ?? null;
  const next = rows[index]?.position ?? null;
  if (!needsRenormalize(prev, next)) {
    return { position: positionBetween(prev, next), renormalized: null };
  }
  const ids = rows.map((r) => r.id);
  const renormalized = renormalize([...ids.slice(0, index), id, ...ids.slice(index)]);
  const own = renormalized.find((u) => u.id === id) as PositionUpdate;
  return { position: own.position, renormalized };
}

/** Position order with ties broken by created_at: the order the repository reads. */
export function byPosition(
  a: { readonly position: number; readonly createdAt?: string },
  b: { readonly position: number; readonly createdAt?: string },
): number {
  if (a.position !== b.position) return a.position - b.position;
  const x = a.createdAt ?? "";
  const y = b.createdAt ?? "";
  return x === y ? 0 : x < y ? -1 : 1;
}

function doneIds(statuses: readonly PlanningStatus[]): Set<string> {
  return new Set(statuses.filter((s) => s.isDone).map((s) => s.id));
}

export function isDoneTask(task: PlanningTask, statuses: readonly PlanningStatus[]): boolean {
  return doneIds(statuses).has(task.statusId);
}

export function filterTasks(
  tasks: readonly PlanningTask[],
  filters: PlanningFilters,
  ctx: { statuses: readonly PlanningStatus[] },
): PlanningTask[] {
  const needle = filters.search.trim().toLowerCase();
  const done = doneIds(ctx.statuses);
  const byProperty = Object.entries(filters.properties);
  return tasks.filter((t) => {
    if (needle && !t.title.toLowerCase().includes(needle)) return false;
    if (!byProperty.every(([id, filter]) => matchesPropertyFilter(t.values[id], filter))) return false;
    if (filters.goal === "none" && t.goalId !== null) return false;
    if (filters.goal !== "all" && filters.goal !== "none" && t.goalId !== filters.goal) return false;
    if (filters.category === "none" && t.category !== null) return false;
    if (filters.category !== "all" && filters.category !== "none" && t.category !== filters.category) return false;
    return !(filters.hideDone && done.has(t.statusId));
  });
}

/** A property filter with what is still there: null when its property (or every picked option) is gone. */
function liveFilter(filter: PropertyFilter, property: PlanningProperty | undefined): PropertyFilter | null {
  if (!property) return null;
  const isSelect = property.type === "select" || property.type === "multi_select";
  if (filter.kind !== "any_of" || !isSelect) return filter;
  const ids = filter.ids.filter((id) => property.options.some((o) => o.id === id));
  if (ids.length === filter.ids.length) return filter;
  return ids.length === 0 ? null : { kind: "any_of", ids };
}

/**
 * A goal, category or property filter whose target left the snapshot falls back to its default,
 * so it never hides every task while the control shows the default. Returns `filters` itself
 * when nothing left.
 */
export function liveFilters(
  filters: PlanningFilters,
  snapshot: Pick<PlanningSnapshot, "goals" | "tasks" | "properties">,
): PlanningFilters {
  const { goal, category } = filters;
  const goalGone = goal !== "all" && goal !== "none" && !snapshot.goals.some((g) => g.id === goal);
  const categoryGone = category !== "all" && category !== "none" && !categoriesOf(snapshot).includes(category);
  const entries = Object.entries(filters.properties);
  const kept = entries.flatMap(([id, filter]): [string, PropertyFilter][] => {
    const live = liveFilter(filter, snapshot.properties.find((p) => p.id === id));
    return live ? [[id, live]] : [];
  });
  const propertiesChanged = kept.length !== entries.length || kept.some(([id, f]) => f !== filters.properties[id]);
  if (!goalGone && !categoryGone && !propertiesChanged) return filters;
  return {
    ...filters,
    goal: goalGone ? DEFAULT_FILTERS.goal : goal,
    category: categoryGone ? DEFAULT_FILTERS.category : category,
    properties: propertiesChanged ? Object.fromEntries(kept) : filters.properties,
  };
}

/** Every category in use on tasks and goals, A to Z. */
export function categoriesOf(snapshot: Pick<PlanningSnapshot, "tasks" | "goals"> & { events?: readonly { category: string | null }[] }): string[] {
  const set = new Set<string>();
  for (const t of snapshot.tasks) if (t.category) set.add(t.category);
  for (const g of snapshot.goals) if (g.category) set.add(g.category);
  for (const e of snapshot.events ?? []) if (e.category) set.add(e.category);
  return [...set].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

/** A category's color, or null. Own keys only: a category named "constructor" has no color. */
export function categoryColorOf(snapshot: Pick<PlanningSnapshot, "categoryColors">, category: string | null | undefined): string | null {
  const map = snapshot.categoryColors;
  return category && map && Object.hasOwn(map, category) ? map[category] : null;
}

/** The color map with `category` set to `color`, or removed when the color is null. */
export function withCategoryColor(map: Readonly<Record<string, string>> | undefined, category: string, color: string | null): Record<string, string> {
  // fromEntries defines own keys, so even a category named "__proto__" stays plain data.
  const rest = Object.entries(map ?? {}).filter(([k]) => k !== category);
  return Object.fromEntries(color === null ? rest : [...rest, [category, color]]);
}

export interface SortContext {
  readonly properties?: readonly PlanningProperty[];
  readonly goals?: readonly Pick<PlanningGoal, "id" | "title">[];
}

const text = (a: string, b: string): number => a.localeCompare(b, "en", { sensitivity: "base" });

/**
 * Tasks in `sort` order. Manual is position order; due, category and property sorts put empty
 * values last in both directions; ties fall back to position. A property sort whose property is
 * gone is manual order.
 */
export function sortTasks(
  tasks: readonly PlanningTask[],
  sort: TaskSortSpec,
  statuses: readonly PlanningStatus[],
  ctx: SortContext = {},
): PlanningTask[] {
  const { key, dir } = sort;
  const sign = dir === "desc" ? -1 : 1;
  const rank = new Map(statuses.map((s) => [s.id, s.position]));
  const property = ctx.properties?.find((p) => `prop:${p.id}` === key);
  const emptyLast = (a: string | null, b: string | null, cmp: (x: string, y: string) => number): number => {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return sign * cmp(a, b);
  };
  const compareKey = (a: PlanningTask, b: PlanningTask): number => {
    switch (key) {
      case "manual":
        return 0;
      case "title":
        return sign * text(a.title, b.title);
      case "due":
        return emptyLast(a.dueDate, b.dueDate, (x, y) => (x < y ? -1 : 1));
      case "category":
        return emptyLast(a.category, b.category, text);
      case "status":
        return sign * ((rank.get(a.statusId) ?? Infinity) - (rank.get(b.statusId) ?? Infinity) || 0);
      case "created":
        return a.createdAt === b.createdAt ? 0 : sign * (a.createdAt < b.createdAt ? -1 : 1);
    }
    if (!property) return 0;
    return comparePropertyValues(property, a.values[property.id], b.values[property.id], dir);
  };
  return [...tasks].sort((a, b) => compareKey(a, b) || (key === "created" ? 0 : byPosition(a, b)));
}

export function tasksInStatus(tasks: readonly PlanningTask[], statusId: string): PlanningTask[] {
  return tasks.filter((t) => t.statusId === statusId).sort(byPosition);
}

/**
 * A task with a patch applied the way the database will: completedAt follows the status, a repeat
 * with no due date takes `today`, and the series starts on the task's own id. The store's
 * optimistic write and the in-memory actions both use it.
 */
export function applyTaskPatch(
  task: PlanningTask,
  patch: TaskPatch,
  statuses: readonly PlanningStatus[],
  now: Date,
  today: string,
): PlanningTask {
  const repeatRule = patch.repeatRule === undefined ? task.repeatRule : patch.repeatRule;
  let dueDate = patch.dueDate === undefined ? task.dueDate : patch.dueDate;
  if (repeatRule && !dueDate) dueDate = today;
  const statusId = patch.statusId ?? task.statusId;
  return {
    ...task,
    title: patch.title ?? task.title,
    notes: patch.notes ?? task.notes,
    statusId,
    position: patch.position ?? task.position,
    goalId: patch.goalId === undefined ? task.goalId : patch.goalId,
    category: patch.category === undefined ? task.category : patch.category,
    dueDate,
    repeatRule,
    repeatSeriesId: repeatRule ? (task.repeatSeriesId ?? task.id) : task.repeatSeriesId,
    alertAt: patch.alertAt === undefined ? task.alertAt : patch.alertAt,
    completedAt: completedAtFor(task, statusId, statuses, now),
    updatedAt: now.toISOString(),
  };
}
