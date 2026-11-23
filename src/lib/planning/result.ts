import { ZodError, type ZodType } from "zod";

import type { PlanningResult } from "./types";

/** An error the owner can read (and a field it belongs to). Everything else becomes a generic one. */
export class PlanningError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "PlanningError";
  }
}

/** Validate input at the trust boundary. The first problem wins; its field rides along. */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const issue = (r.error as ZodError).issues[0];
  const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
  throw new PlanningError(issue?.message && issue.message !== "Invalid input" ? issue.message : "That is not valid.", field);
}

const PG_MESSAGES: ReadonlyArray<[RegExp, string]> = [
  [/planning: no access/, "Not allowed."],
  [/planning: last status/, "A board needs at least one status."],
  [/planning: status in use/, "Move its tasks to another status first."],
  [/planning: bad move target/, "Pick another status to move the tasks to."],
  [/planning: unknown task/, "That task is gone."],
  [/planning: unknown item/, "That item is gone."],
  [/planning: bad property value/, "That value does not fit this property."],
  [/planning: property type is fixed/, "A property's type cannot change."],
  [/planning: too many properties/, "That is the most properties allowed."],
  [/planning: too many options/, "That is the most options allowed."],
  [/planning: (statuses|properties|options) changed/, "That list changed. Reload and try again."],
  [/planning_tasks_repeat_needs_due/, "A repeating task needs a due date."],
  [/planning_goals_start_date_check/, "The start date must be on or before the deadline."],
  [/events_end_after_start/, "An event cannot end before it starts."],
  [/planning_goal_metrics_goal_metric_param_key/, "That metric is already on this goal."],
  [/planning_properties_name_key/, "A property with that name exists."],
  [/planning_property_options_label_key/, "An option with that name exists."],
  [/foreign key/, "That item is gone."],
];

type DbError = { message?: string; code?: string } | null | undefined;

/** Throw a readable PlanningError for a PostgREST error; pass through when there is none. */
export function check(error: DbError): void {
  if (!error) return;
  const text = `${error.message ?? ""}`;
  const hit = PG_MESSAGES.find(([re]) => re.test(text));
  if (hit) throw new PlanningError(hit[1]);
  if (error.code === "42501") throw new PlanningError("Not allowed.");
  if (error.code === "23505") throw new PlanningError("That already exists.");
  throw new Error(text || "Planning write failed");
}

/** Run an action body and fold every failure into a PlanningResult. Unknown errors are logged, not shown. */
export async function toResult<T>(body: () => Promise<T>): Promise<PlanningResult<T>> {
  try {
    return { ok: true, value: await body() };
  } catch (e) {
    if (e instanceof PlanningError) return { ok: false, error: e.message, ...(e.field ? { field: e.field } : {}) };
    console.error("planning action failed", e);
    return { ok: false, error: "Something went wrong. Try again." };
  }
}
