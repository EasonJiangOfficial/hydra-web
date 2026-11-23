import type { SupabaseClient } from "@supabase/supabase-js";

import { DEFAULT_TIME_ZONE } from "./dates";
import { METRIC_KEYS, type MetricKey } from "./metrics";
import {
  sortPropertyRows,
  toProperty,
  valueFromRow,
  type PlanningProperty,
  type PropertyValue,
} from "./properties";
import { REPEAT_RULES, type RepeatRule } from "./repeat";
import type {
  EventRow,
  PlanningCategoryColorRow,
  PlanningGoalLinkRow,
  PlanningGoalMetricRow,
  PlanningGoalRow,
  PlanningPropertyOptionRow,
  PlanningPropertyRow,
  PlanningStatusRow,
  PlanningTaskRow,
  PlanningTaskValueRow,
} from "./rows";
import type {
  GoalLink,
  GoalMetric,
  PlanningEvent,
  PlanningGoal,
  PlanningSnapshot,
  PlanningStatus,
  PlanningTask,
} from "./types";

/** Rows to domain objects. Pure: the repository and the tests share it. */

const rule = (v: string | null): RepeatRule | null =>
  v !== null && (REPEAT_RULES as readonly string[]).includes(v) ? (v as RepeatRule) : null;

export const toStatus = (r: PlanningStatusRow): PlanningStatus => ({
  id: r.id,
  label: r.label,
  color: r.color,
  position: r.position,
  isDone: r.is_done,
  createdAt: r.created_at,
});

export const toTask = (r: PlanningTaskRow, values: Readonly<Record<string, PropertyValue>> = {}): PlanningTask => ({
  id: r.id,
  title: r.title,
  notes: r.notes,
  statusId: r.status_id,
  goalId: r.goal_id,
  category: r.category,
  dueDate: r.due_date,
  position: r.position,
  alertAt: r.alert_at,
  repeatRule: rule(r.repeat_rule),
  repeatSeriesId: r.repeat_series_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
  values,
});

export const toMetric = (r: PlanningGoalMetricRow): GoalMetric => ({
  id: r.id,
  goalId: r.goal_id,
  metric: (METRIC_KEYS as readonly string[]).includes(r.metric) ? (r.metric as MetricKey) : "task_progress",
  target: Number(r.target),
  param: r.param,
  position: r.position,
});

export const toLink = (r: PlanningGoalLinkRow): GoalLink => ({
  id: r.id,
  goalId: r.goal_id,
  url: r.url,
  title: r.title,
  position: r.position,
});

export const toGoal = (
  r: PlanningGoalRow,
  metrics: readonly PlanningGoalMetricRow[] = [],
  links: readonly PlanningGoalLinkRow[] = [],
): PlanningGoal => ({
  id: r.id,
  title: r.title,
  notes: r.notes,
  category: r.category,
  startDate: r.start_date,
  deadline: r.deadline,
  position: r.position,
  achievedAt: r.achieved_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  metrics: metrics.filter((m) => m.goal_id === r.id).sort((a, b) => a.position - b.position).map(toMetric),
  links: links.filter((l) => l.goal_id === r.id).sort((a, b) => a.position - b.position).map(toLink),
});

export const toEvent = (r: EventRow): PlanningEvent => ({
  id: r.id,
  title: r.title,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  allDay: r.all_day,
  category: r.category,
  repeat: rule(r.repeat),
  notes: r.notes,
  alertAt: r.alert_at,
  googleEventId: r.google_event_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface PlanningRows {
  statuses: readonly PlanningStatusRow[];
  goals: readonly PlanningGoalRow[];
  metrics: readonly PlanningGoalMetricRow[];
  links: readonly PlanningGoalLinkRow[];
  tasks: readonly PlanningTaskRow[];
  events: readonly EventRow[];
  properties: readonly PlanningPropertyRow[];
  options: readonly PlanningPropertyOptionRow[];
  values: readonly PlanningTaskValueRow[];
  /** 0118; optional so callers that predate it still build a snapshot. */
  categoryColors?: readonly PlanningCategoryColorRow[];
  timeZone: string;
}

export function snapshotFromRows(rows: PlanningRows): PlanningSnapshot {
  const properties: PlanningProperty[] = sortPropertyRows(rows.properties).map((p) =>
    toProperty(p, rows.options.filter((o) => o.property_id === p.id)),
  );
  const typeOf = new Map(properties.map((p) => [p.id, p.type]));
  const valuesByTask = new Map<string, Record<string, PropertyValue>>();
  for (const row of rows.values) {
    const type = typeOf.get(row.property_id);
    const value = type ? valueFromRow(type, row) : null;
    if (!value) continue;
    const bucket = valuesByTask.get(row.task_id) ?? {};
    bucket[row.property_id] = value;
    valuesByTask.set(row.task_id, bucket);
  }
  return {
    statuses: [...rows.statuses].sort((a, b) => a.position - b.position || (a.created_at < b.created_at ? -1 : 1)).map(toStatus),
    tasks: rows.tasks.map((t) => toTask(t, valuesByTask.get(t.id))),
    goals: [...rows.goals].sort((a, b) => a.position - b.position).map((g) => toGoal(g, rows.metrics, rows.links)),
    events: rows.events.map(toEvent),
    properties,
    categoryColors: Object.fromEntries((rows.categoryColors ?? []).map((c) => [c.category, c.color])),
    timeZone: rows.timeZone,
  };
}

const PAGE = 1000;

/** PostgREST caps a response (1000 rows by default): read every page. */
async function all<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE) return out;
  }
}

/** The owner's time zone (settings.time_zone), or the default until the first login writes it. */
export async function loadTimeZone(db: SupabaseClient): Promise<string> {
  const { data } = await db.from("settings").select("time_zone").limit(1).maybeSingle();
  return (data?.time_zone as string | null | undefined) ?? DEFAULT_TIME_ZONE;
}

/**
 * Everything Planning shows, in one load. Single owner, so it is small: every task and every
 * value, no paging in the UI.
 * ponytail: loads all rows; add a done-before window if the table passes a few thousand tasks.
 */
export async function loadSnapshot(db: SupabaseClient): Promise<PlanningSnapshot> {
  const [statuses, goals, metrics, links, tasks, events, properties, options, values, categoryColors, timeZone] = await Promise.all([
    all<PlanningStatusRow>((a, b) => db.from("planning_statuses").select("*").order("position").range(a, b)),
    all<PlanningGoalRow>((a, b) => db.from("planning_goals").select("*").order("position").range(a, b)),
    all<PlanningGoalMetricRow>((a, b) => db.from("planning_goal_metrics").select("*").order("position").range(a, b)),
    all<PlanningGoalLinkRow>((a, b) => db.from("planning_goal_links").select("*").order("position").range(a, b)),
    all<PlanningTaskRow>((a, b) => db.from("planning_tasks").select("*").order("position").order("id").range(a, b)),
    all<EventRow>((a, b) => db.from("events").select("*").order("starts_at").order("id").range(a, b)),
    all<PlanningPropertyRow>((a, b) => db.from("planning_properties").select("*").order("position").range(a, b)),
    all<PlanningPropertyOptionRow>((a, b) => db.from("planning_property_options").select("*").order("position").range(a, b)),
    all<PlanningTaskValueRow>((a, b) => db.from("planning_task_values").select("*").order("task_id").order("property_id").range(a, b)),
    all<PlanningCategoryColorRow>((a, b) => db.from("planning_category_colors").select("*").order("category").range(a, b)),
    loadTimeZone(db),
  ]);
  return snapshotFromRows({ statuses, goals, metrics, links, tasks, events, properties, options, values, categoryColors, timeZone });
}
