import {
  METRICS,
  defaultMetricRegistry,
  goalPercent,
  goalWindow,
  metricPercent,
  type MetricRegistry,
} from "./metrics";
import { byPosition } from "./tasks";
import type { PlanningGoal, PlanningStatus, PlanningTask } from "./types";

/**
 * Goals as the page lists them: dated goals first, soonest date first; then goals with no date.
 * Ties keep the owner's own order (position).
 */
export function sortGoals(goals: readonly PlanningGoal[]): PlanningGoal[] {
  return [...goals].sort((a, b) => {
    if (a.deadline === b.deadline) return byPosition(a, b);
    if (a.deadline === null) return 1;
    if (b.deadline === null) return -1;
    return a.deadline < b.deadline ? -1 : 1;
  });
}

export function goalTaskProgress(
  goalId: string,
  tasks: readonly PlanningTask[],
  statuses: readonly PlanningStatus[],
): { done: number; total: number; percent: number } {
  const done = new Set(statuses.filter((s) => s.isDone).map((s) => s.id));
  const linked = tasks.filter((t) => t.goalId === goalId);
  const finished = linked.filter((t) => done.has(t.statusId)).length;
  const total = linked.length;
  return { done: finished, total, percent: total === 0 ? 0 : Math.round((finished / total) * 100) };
}

export interface GoalMetricReading {
  readonly metricId: string;
  readonly value: number | null;
  readonly percent: number;
  /** True while no unit has registered a live resolver for this metric. */
  readonly stub: boolean;
}

export interface GoalReading {
  readonly percent: number;
  readonly metrics: readonly GoalMetricReading[];
  readonly tasks: { done: number; total: number; percent: number };
}

/** Every metric of a goal resolved through the registry, and the goal's overall percent. */
export async function readGoal(
  goal: PlanningGoal,
  ctx: {
    readonly tasks: readonly PlanningTask[];
    readonly statuses: readonly PlanningStatus[];
    readonly today: string;
    readonly timeZone: string;
    readonly registry?: MetricRegistry;
  },
): Promise<GoalReading> {
  const registry = ctx.registry ?? defaultMetricRegistry;
  const window = goalWindow(goal, ctx.today, ctx.timeZone);
  const readings = await Promise.all(
    goal.metrics.map(async (m): Promise<GoalMetricReading> => {
      const { value, stub } = await registry.resolve(m.metric, m.param, {
        goalId: goal.id,
        window,
        today: ctx.today,
        timeZone: ctx.timeZone,
        tasks: ctx.tasks,
        statuses: ctx.statuses,
      });
      return { metricId: m.id, value, stub, percent: metricPercent(METRICS[m.metric], value, m.target) };
    }),
  );
  const tasks = goalTaskProgress(goal.id, ctx.tasks, ctx.statuses);
  const values = Object.fromEntries(readings.map((r) => [r.metricId, r.value]));
  return { percent: goalPercent(goal, values, tasks), metrics: readings, tasks };
}
