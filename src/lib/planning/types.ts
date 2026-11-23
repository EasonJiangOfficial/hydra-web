import type { MetricKey } from "./metrics";
import type {
  OptionInput,
  OptionPatch,
  PlanningOption,
  PlanningProperty,
  PropertyFilter,
  PropertyInput,
  PropertyPatch,
  PropertyValue,
} from "./properties";
import type { RepeatRule } from "./repeat";
import type {
  CreateEventInput,
  CreateGoalInput,
  CreateStatusInput,
  CreateTaskInput,
  CategoryColor,
  EventPatch,
  GoalLinkInput,
  GoalLinkPatch,
  GoalMetricInput,
  GoalMetricPatch,
  GoalPatch,
  PositionUpdate,
  StatusPatch,
  TaskPatch,
  TaskPositionUpdate,
} from "./schemas";

export type { PlanningOption, PlanningProperty, PropertyFilter, PropertyValue } from "./properties";

export interface PlanningStatus {
  readonly id: string;
  readonly label: string;
  /** `#rrggbb`: the dot beside the column name. */
  readonly color: string;
  readonly position: number;
  readonly isDone: boolean;
  /** Breaks a position tie (the order the repository reads). */
  readonly createdAt?: string;
}

export interface PlanningTask {
  readonly id: string;
  readonly title: string;
  readonly notes: string;
  readonly statusId: string;
  readonly goalId: string | null;
  readonly category: string | null;
  readonly dueDate: string | null;
  readonly position: number;
  /** When Hydra tells the owner (a reminder is a task with an alert). ISO instant. */
  readonly alertAt: string | null;
  /** Null: does not repeat. A repeating task always has a due date. */
  readonly repeatRule: RepeatRule | null;
  /** The series' first task; server-owned. */
  readonly repeatSeriesId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  /** Property values by property id; a property with no value is absent. */
  readonly values: Readonly<Record<string, PropertyValue>>;
}

export interface GoalMetric {
  readonly id: string;
  readonly goalId: string;
  readonly metric: MetricKey;
  readonly target: number;
  /** category_spend: the category it measures. */
  readonly param: string | null;
  readonly position: number;
}

export interface GoalLink {
  readonly id: string;
  readonly goalId: string;
  readonly url: string;
  readonly title: string | null;
  readonly position: number;
}

export interface PlanningGoal {
  readonly id: string;
  readonly title: string;
  readonly notes: string;
  readonly category: string | null;
  /** Null: the day the goal was made starts its metric window. */
  readonly startDate: string | null;
  readonly deadline: string | null;
  readonly position: number;
  readonly achievedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metrics: readonly GoalMetric[];
  readonly links: readonly GoalLink[];
}

export interface PlanningEvent {
  readonly id: string;
  readonly title: string;
  /** ISO instant of the first occurrence. */
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly allDay: boolean;
  readonly category: string | null;
  /** One row for the whole series; occurrences are computed (events.ts). */
  readonly repeat: RepeatRule | null;
  readonly notes: string;
  /** Alert for the first occurrence; later ones keep the same lead time. */
  readonly alertAt: string | null;
  readonly googleEventId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlanningSnapshot {
  readonly statuses: readonly PlanningStatus[];
  readonly tasks: readonly PlanningTask[];
  readonly goals: readonly PlanningGoal[];
  readonly events: readonly PlanningEvent[];
  readonly properties: readonly PlanningProperty[];
  /** Category text -> `#rrggbb`. A category with no entry (or no map) has no color. */
  readonly categoryColors?: Readonly<Record<string, string>>;
  /** The owner's IANA zone (settings.time_zone). */
  readonly timeZone: string;
}

export type PlanningResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: string;
      /** The form field the error belongs to: shown next to it, not as a toast. */
      readonly field?: string;
    };

export type PlanningView = "board" | "table";

export type TaskSortKey = "manual" | "due" | "status" | "created" | "title" | "category" | `prop:${string}`;

/** One sort for both views. Empty values sort last in both directions. */
export interface TaskSortSpec {
  readonly key: TaskSortKey;
  readonly dir: "asc" | "desc";
}

export const DEFAULT_TABLE_SORT: TaskSortSpec = { key: "status", dir: "asc" };
export const DEFAULT_BOARD_SORT: TaskSortSpec = { key: "manual", dir: "asc" };

/** Board columns: "status", "category", "goal", or `prop:<select property id>` (Priority is one). */
export type BoardGroupBy = string;

export interface PlanningFilters {
  readonly search: string;
  /** 'all' | 'none' | goal id */
  readonly goal: string;
  /** 'all' | 'none' | a category */
  readonly category: string;
  readonly hideDone: boolean;
  /** Property id -> its filter; every one must match. */
  readonly properties: Readonly<Record<string, PropertyFilter>>;
}

export const DEFAULT_FILTERS: PlanningFilters = {
  search: "",
  goal: "all",
  category: "all",
  hideDone: false,
  properties: {},
};

/** A delete's result: on success the server's `activityId` undoes it (the in-memory copy has none). */
type Deleted = Promise<PlanningResult<null> & { activityId?: string | null }>;

/**
 * Every Planning write. The pages call these through server actions (actions.ts), /dev/planning
 * calls an in-memory copy (memory-actions.ts), and the Hydra Agent (U13) calls the server ones.
 * Same names, same inputs, same results.
 */
export interface PlanningActions {
  readonly loadPlanning: () => Promise<PlanningResult<PlanningSnapshot>>;

  readonly createTask: (input: CreateTaskInput) => Promise<PlanningResult<PlanningTask>>;
  readonly updateTask: (id: string, patch: TaskPatch) => Promise<PlanningResult<PlanningTask>>;
  /** One atomic write: reorder inside a column, or move across columns (statusId on the moved task). */
  readonly setTaskPositions: (updates: readonly TaskPositionUpdate[]) => Promise<PlanningResult<null>>;
  /** Done: the first done status. Not done: the first status that is not done. */
  readonly completeTask: (id: string, done: boolean) => Promise<PlanningResult<PlanningTask>>;
  readonly deleteTask: (id: string) => Deleted;
  /** Null stops it. A repeat needs a due date: an undated task is dated today. */
  readonly setTaskRepeat: (id: string, rule: RepeatRule | null) => Promise<PlanningResult<PlanningTask>>;
  readonly setTaskAlert: (id: string, alertAt: string) => Promise<PlanningResult<PlanningTask>>;
  readonly clearTaskAlert: (id: string) => Promise<PlanningResult<PlanningTask>>;

  readonly createGoal: (input: CreateGoalInput) => Promise<PlanningResult<PlanningGoal>>;
  readonly updateGoal: (id: string, patch: GoalPatch) => Promise<PlanningResult<PlanningGoal>>;
  readonly deleteGoal: (id: string) => Deleted;
  readonly setGoalPositions: (updates: readonly PositionUpdate[]) => Promise<PlanningResult<null>>;
  readonly addGoalMetric: (input: GoalMetricInput) => Promise<PlanningResult<GoalMetric>>;
  readonly updateGoalMetric: (id: string, patch: GoalMetricPatch) => Promise<PlanningResult<GoalMetric>>;
  readonly removeGoalMetric: (id: string) => Deleted;
  readonly addGoalLink: (input: GoalLinkInput) => Promise<PlanningResult<GoalLink>>;
  readonly updateGoalLink: (id: string, patch: GoalLinkPatch) => Promise<PlanningResult<GoalLink>>;
  readonly removeGoalLink: (id: string) => Deleted;

  readonly createEvent: (input: CreateEventInput) => Promise<PlanningResult<PlanningEvent>>;
  readonly updateEvent: (id: string, patch: EventPatch) => Promise<PlanningResult<PlanningEvent>>;
  readonly deleteEvent: (id: string) => Deleted;
  readonly setEventAlert: (id: string, alertAt: string) => Promise<PlanningResult<PlanningEvent>>;
  readonly clearEventAlert: (id: string) => Promise<PlanningResult<PlanningEvent>>;

  readonly createStatus: (input: CreateStatusInput) => Promise<PlanningResult<PlanningStatus>>;
  readonly updateStatus: (id: string, patch: StatusPatch) => Promise<PlanningResult<PlanningStatus>>;
  readonly reorderStatuses: (orderedIds: readonly string[]) => Promise<PlanningResult<null>>;
  readonly deleteStatus: (id: string, moveTo: string | null) => Deleted;
  /** Color a category (free text on tasks, goals and events); a null color clears it. */
  readonly setCategoryColor: (category: string, color: string | null) => Promise<PlanningResult<CategoryColor>>;

  /** Lands after the last property, with no options. */
  readonly createProperty: (input: PropertyInput) => Promise<PlanningResult<PlanningProperty>>;
  /** Never the type. */
  readonly updateProperty: (id: string, patch: PropertyPatch) => Promise<PlanningResult<PlanningProperty>>;
  readonly reorderProperties: (orderedIds: readonly string[]) => Promise<PlanningResult<null>>;
  /** Clears its value on every task. */
  readonly deleteProperty: (id: string) => Deleted;
  readonly createOption: (input: OptionInput) => Promise<PlanningResult<PlanningOption>>;
  readonly updateOption: (id: string, patch: OptionPatch) => Promise<PlanningResult<PlanningOption>>;
  readonly reorderOptions: (propertyId: string, orderedIds: readonly string[]) => Promise<PlanningResult<null>>;
  /** Removes it from every task (a value left with none is cleared). */
  readonly deleteOption: (id: string) => Deleted;
  /** Null clears the value. The reply is the saved value (null: cleared). */
  readonly setTaskValue: (
    taskId: string,
    propertyId: string,
    value: PropertyValue | null,
  ) => Promise<PlanningResult<PropertyValue | null>>;
  /** How many tasks have a value of this property, or use this option. */
  readonly propertyUsage: (propertyOrOptionId: string) => Promise<PlanningResult<number>>;
}
