import { dayOf } from "./dates";
import type { PlanningGoal, PlanningStatus, PlanningTask } from "./types";

/**
 * The metric registry: what a goal can measure (DESIGN.md section 10). The definitions are fixed
 * here and in the migration's key list. The VALUES come from resolvers that later units register:
 * U1 and U5 fill money and UGC figures, U3 category spend. Until then a key answers with a stub
 * value and says so (`stub: true`), so the goal UI can render real-looking bars on fixtures and
 * the pages can mark numbers that are not live yet. task_progress is real: it needs only tasks.
 */
export const METRIC_KEYS = [
  "net_worth",
  "monthly_income",
  "ugc_revenue",
  "savings_rate",
  "category_spend",
  "posts_per_day",
  "streak",
  "total_views",
  "views_per_post",
  "task_progress",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export type MetricUnit = "money" | "percent" | "count" | "days";

export interface MetricDef {
  readonly key: MetricKey;
  readonly label: string;
  readonly unit: MetricUnit;
  /** "down": a cap, so staying at or under the target is the goal (category spend). */
  readonly direction: "up" | "down";
  /** category_spend names the category it measures. */
  readonly takesCategory: boolean;
  /** One line for the info dot (formula in words). */
  readonly info: string;
}

export const METRICS: Readonly<Record<MetricKey, MetricDef>> = {
  net_worth: { key: "net_worth", label: "Net worth", unit: "money", direction: "up", takesCategory: false, info: "Assets minus debts, today." },
  monthly_income: { key: "monthly_income", label: "Monthly income", unit: "money", direction: "up", takesCategory: false, info: "Deposits that are income this month, before card bills." },
  ugc_revenue: { key: "ugc_revenue", label: "UGC revenue", unit: "money", direction: "up", takesCategory: false, info: "UGC earned inside the goal's dates." },
  savings_rate: { key: "savings_rate", label: "Savings rate", unit: "percent", direction: "up", takesCategory: false, info: "Share of income kept this month." },
  category_spend: { key: "category_spend", label: "Category spend", unit: "money", direction: "down", takesCategory: true, info: "Spending in one category inside the goal's dates. Stay under the target." },
  posts_per_day: { key: "posts_per_day", label: "Posts per day", unit: "count", direction: "up", takesCategory: false, info: "Counted posts per day over the goal's dates." },
  streak: { key: "streak", label: "Streak", unit: "days", direction: "up", takesCategory: false, info: "Days in a row the posting target was hit." },
  total_views: { key: "total_views", label: "Total views", unit: "count", direction: "up", takesCategory: false, info: "Views on counted videos inside the goal's dates." },
  views_per_post: { key: "views_per_post", label: "Views per post", unit: "count", direction: "up", takesCategory: false, info: "Total views divided by counted posts." },
  task_progress: { key: "task_progress", label: "Task progress", unit: "percent", direction: "up", takesCategory: false, info: "Done tasks linked to this goal, as a share of all linked tasks." },
};

/** The goal's dates: from its start (or the day it was made) to its deadline (or today). */
export interface MetricWindow {
  readonly from: string;
  readonly to: string;
}

export function goalWindow(
  goal: Pick<PlanningGoal, "startDate" | "deadline" | "createdAt">,
  today: string,
  tz: string,
): MetricWindow {
  return { from: goal.startDate ?? dayOf(goal.createdAt, tz), to: goal.deadline ?? today };
}

export interface MetricContext {
  readonly goalId: string;
  readonly window: MetricWindow;
  readonly today: string;
  readonly timeZone: string;
  readonly tasks: readonly PlanningTask[];
  readonly statuses: readonly PlanningStatus[];
}

/** A resolver answers with the live value, or null when there is nothing to measure yet. */
export type MetricResolver = (param: string | null, ctx: MetricContext) => number | null | Promise<number | null>;

export interface MetricValue {
  readonly value: number | null;
  /** True while the value is a placeholder (no unit has registered a resolver for this key). */
  readonly stub: boolean;
}

/** Placeholder figures for fixtures and for keys no unit has filled yet. */
export const STUB_VALUES: Readonly<Record<Exclude<MetricKey, "task_progress">, number>> = {
  net_worth: 48_212,
  monthly_income: 6_400,
  ugc_revenue: 3_150,
  savings_rate: 31,
  category_spend: 420,
  posts_per_day: 2.4,
  streak: 9,
  total_views: 182_000,
  views_per_post: 9_600,
};

/** Task progress: done linked tasks over all linked tasks, 0 to 100; null with no linked task. */
export function taskProgressValue(ctx: Pick<MetricContext, "goalId" | "tasks" | "statuses">): number | null {
  const done = new Set(ctx.statuses.filter((s) => s.isDone).map((s) => s.id));
  const linked = ctx.tasks.filter((t) => t.goalId === ctx.goalId);
  if (linked.length === 0) return null;
  return Math.round((linked.filter((t) => done.has(t.statusId)).length / linked.length) * 100);
}

export interface MetricRegistry {
  has(key: MetricKey): boolean;
  /** A registry with `resolver` answering for `key`. Does not change this one. */
  register(key: MetricKey, resolver: MetricResolver): MetricRegistry;
  resolve(key: MetricKey, param: string | null, ctx: MetricContext): Promise<MetricValue>;
}

export function createMetricRegistry(resolvers: Partial<Record<MetricKey, MetricResolver>> = {}): MetricRegistry {
  const all: Partial<Record<MetricKey, MetricResolver>> = {
    task_progress: (_param, ctx) => taskProgressValue(ctx),
    ...resolvers,
  };
  return {
    has: (key) => all[key] !== undefined,
    register: (key, resolver) => createMetricRegistry({ ...all, [key]: resolver }),
    async resolve(key, param, ctx) {
      const resolver = all[key];
      if (resolver) return { value: await resolver(param, ctx), stub: false };
      return { value: key === "task_progress" ? null : STUB_VALUES[key], stub: true };
    },
  };
}

/** The shared default: stubs plus real task progress. Units that fill a key build their own with `register`. */
export const defaultMetricRegistry = createMetricRegistry();

/** How far a value is from its target, 0 to 100. A cap ("down") is 100 while at or under it. */
export function metricPercent(def: Pick<MetricDef, "direction">, value: number | null, target: number): number {
  if (value === null || target <= 0) return 0;
  if (def.direction === "down") return value <= target ? 100 : Math.max(0, Math.round((target / value) * 100));
  return Math.min(100, Math.max(0, Math.round((value / target) * 100)));
}

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const one = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** "$48,212", "31%", "9,600", "9 days". "-" for no value. */
export function formatMetric(def: Pick<MetricDef, "unit">, value: number | null): string {
  if (value === null) return "-";
  switch (def.unit) {
    case "money":
      return `${value < 0 ? "-" : ""}$${whole.format(Math.abs(value))}`;
    case "percent":
      return `${one.format(value)}%`;
    case "days":
      return `${whole.format(value)} ${value === 1 ? "day" : "days"}`;
    case "count":
      return Number.isInteger(value) ? whole.format(value) : one.format(value);
  }
}

/**
 * A goal's progress, 0 to 100: the average of its metrics' percents, or its linked tasks' progress
 * when it has no metric. `values` are the resolved metric values by metric row id.
 */
export function goalPercent(
  goal: Pick<PlanningGoal, "id" | "metrics">,
  values: Readonly<Record<string, number | null>>,
  tasksDone: { done: number; total: number },
): number {
  if (goal.metrics.length === 0) {
    return tasksDone.total === 0 ? 0 : Math.round((tasksDone.done / tasksDone.total) * 100);
  }
  const sum = goal.metrics.reduce(
    (acc, m) => acc + metricPercent(METRICS[m.metric], values[m.id] ?? null, m.target),
    0,
  );
  return Math.round(sum / goal.metrics.length);
}
