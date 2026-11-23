"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { withActivity, type WithActivity } from "@/lib/activity/request";
import { pushToGoogle, removeFromGoogle, type ItemKind } from "@/lib/google/calendar";

import { todayIn } from "./dates";
import {
  optionInputSchema,
  optionPatchSchema,
  propertyInputSchema,
  propertyPatchSchema,
  propertyValueSchema,
  toOption,
  toProperty,
  valueToColumns,
  idOrderSchema,
  type OptionInput,
  type OptionPatch,
  type PropertyInput,
  type PropertyPatch,
  type PropertyValue,
} from "./properties";
import type { RepeatRule } from "./repeat";
import { check, parse, PlanningError, toResult } from "./result";
import { loadSnapshot, toEvent, toGoal, toLink, toMetric, toStatus, toTask } from "./repository";
import type {
  EventRow,
  PlanningGoalLinkRow,
  PlanningGoalMetricRow,
  PlanningGoalRow,
  PlanningPropertyOptionRow,
  PlanningPropertyRow,
  PlanningStatusRow,
  PlanningTaskRow,
} from "./rows";
import {
  categoryColorSchema,
  createEventSchema,
  createGoalSchema,
  createStatusSchema,
  createTaskSchema,
  eventPatchSchema,
  goalLinkInputSchema,
  goalLinkPatchSchema,
  goalMetricInputSchema,
  goalMetricPatchSchema,
  goalPatchSchema,
  isoInstantSchema,
  planningIdSchema,
  positionUpdatesSchema,
  statusOrderSchema,
  statusPatchSchema,
  taskPatchSchema,
  taskPositionUpdatesSchema,
  type CategoryColor,
  type CreateEventInput,
  type CreateGoalInput,
  type CreateStatusInput,
  type CreateTaskInput,
  type EventPatch,
  type GoalLinkInput,
  type GoalLinkPatch,
  type GoalMetricInput,
  type GoalMetricPatch,
  type GoalPatch,
  type PositionUpdate,
  type StatusPatch,
  type TaskPatch,
  type TaskPositionUpdate,
} from "./schemas";
import { ownerCtx, type PlanningCtx } from "./server";
import { statusForDone } from "./tasks";
import type {
  GoalLink,
  GoalMetric,
  PlanningEvent,
  PlanningGoal,
  PlanningOption,
  PlanningProperty,
  PlanningResult,
  PlanningSnapshot,
  PlanningStatus,
  PlanningTask,
} from "./types";

/**
 * Every Planning write as a typed server action (DESIGN.md section 10; PLAN.md "typed actions").
 * The pages and the Hydra Agent (U13) call exactly these. Each one: owner check (ownerCtx), input
 * validated with the shared zod schemas, one database call per change, every failure folded into a
 * PlanningResult (readable message, optional field). A task reply carries `values: {}`: property
 * values are owned by setTaskValue, so a caller keeps the values it already has.
 */

const STEP = 1024;

const act = <T>(body: (ctx: PlanningCtx) => Promise<T>): Promise<PlanningResult<T>> =>
  toResult(async () => body(await ownerCtx()));

type Db = SupabaseClient;

/**
 * After a task or event write succeeds, mirror it to the Hydra Google calendar once the response
 * is sent. No Google sign-in: pushToGoogle answers not_connected and nothing changes.
 */
async function mirrored<T>(kind: ItemKind, write: Promise<PlanningResult<T>>, id: (value: T) => string, remove = false): Promise<PlanningResult<T>> {
  const result = await write;
  if (result.ok) {
    const itemId = id(result.value);
    after(async () => {
      const r = await (remove ? removeFromGoogle : pushToGoogle)(kind, itemId);
      if (!r.ok && r.error.code !== "not_configured") console.error(`[planning] google ${kind} ${itemId}: ${r.error.code}`);
    });
  }
  return result;
}

async function one<T>(q: PromiseLike<{ data: T | null; error: { message?: string; code?: string } | null }>): Promise<T> {
  const { data, error } = await q;
  check(error);
  if (data === null) throw new PlanningError("That item is gone.");
  return data;
}

async function none(q: PromiseLike<{ error: { message?: string; code?: string } | null }>): Promise<void> {
  check((await q).error);
}

/** The row after the last one: max(position) + step. */
async function nextPosition(db: Db, table: string, filter?: [string, string]): Promise<number> {
  let q = db.from(table).select("position").order("position", { ascending: false }).limit(1);
  if (filter) q = q.eq(filter[0], filter[1]);
  const { data, error } = await q;
  check(error);
  return ((data?.[0]?.position as number | undefined) ?? 0) + STEP;
}

// ── tasks ───────────────────────────────────────────────────────────────

const TASK_COLUMNS = {
  title: "title",
  notes: "notes",
  statusId: "status_id",
  position: "position",
  goalId: "goal_id",
  category: "category",
  dueDate: "due_date",
  repeatRule: "repeat_rule",
  alertAt: "alert_at",
} as const;

function toColumns(patch: Record<string, unknown>, map: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined).map(([k, v]) => [map[k], v]));
}

async function getTask(db: Db, id: string): Promise<PlanningTask> {
  return toTask(await one<PlanningTaskRow>(db.from("planning_tasks").select("*").eq("id", id).maybeSingle()));
}

/** A repeat needs a due date: an undated task is dated today in the owner's zone. */
async function withRepeatDue(ctx: PlanningCtx, id: string | null, patch: TaskPatch): Promise<TaskPatch> {
  if (!patch.repeatRule || patch.dueDate !== undefined) return patch;
  if (id) {
    const { data, error } = await ctx.db.from("planning_tasks").select("due_date").eq("id", id).maybeSingle();
    check(error);
    if (data?.due_date) return patch;
  }
  return { ...patch, dueDate: todayIn(ctx.now(), await ctx.timeZone()) };
}

async function patchTask(ctx: PlanningCtx, id: string, rawPatch: unknown): Promise<PlanningTask> {
  planId(id);
  const patch = await withRepeatDue(ctx, id, parse(taskPatchSchema, rawPatch));
  const row = await one<PlanningTaskRow>(
    ctx.db.from("planning_tasks").update(toColumns(patch, TASK_COLUMNS)).eq("id", id).select("*").maybeSingle(),
  );
  return toTask(row);
}

function planId(id: unknown): string {
  return parse(planningIdSchema, id);
}

export async function loadPlanning(): Promise<PlanningResult<PlanningSnapshot>> {
  return act(({ db }) => loadSnapshot(db));
}

export async function createTask(input: CreateTaskInput): Promise<PlanningResult<PlanningTask>> {
  return mirrored("task", act(async (ctx) => {
    const t = parse(createTaskSchema, input);
    const due = (await withRepeatDue(ctx, null, { repeatRule: t.repeatRule, dueDate: t.dueDate ?? undefined })).dueDate ?? t.dueDate;
    // Insert-or-ignore on the client's id: a retry after a lost reply returns the first row.
    await none(
      ctx.db.from("planning_tasks").upsert(
        {
          id: t.id,
          title: t.title,
          status_id: t.statusId,
          position: t.position,
          goal_id: t.goalId,
          category: t.category,
          due_date: due,
          alert_at: t.alertAt,
          repeat_rule: t.repeatRule,
        },
        { onConflict: "id", ignoreDuplicates: true },
      ),
    );
    return getTask(ctx.db, t.id);
  }), (t) => t.id);
}

export async function updateTask(id: string, patch: TaskPatch): Promise<PlanningResult<PlanningTask>> {
  return mirrored("task", act((ctx) => patchTask(ctx, id, patch)), (t) => t.id);
}

/** One atomic write (planning_set_task_positions): reorder in a column, or move across columns. */
export async function setTaskPositions(updates: readonly TaskPositionUpdate[]): Promise<PlanningResult<null>> {
  return act(async ({ db }) => {
    const items = parse(taskPositionUpdatesSchema, updates);
    await none(
      db.rpc("planning_set_task_positions", {
        p_items: items.map((u) => ({ id: u.id, position: u.position, status_id: u.statusId })),
      }),
    );
    return null;
  });
}

export async function completeTask(id: string, done: boolean): Promise<PlanningResult<PlanningTask>> {
  return mirrored("task", act(async (ctx) => {
    planId(id);
    const { data, error } = await ctx.db.from("planning_statuses").select("*");
    check(error);
    const target = statusForDone((data as PlanningStatusRow[]).map(toStatus), done);
    if (!target) throw new PlanningError(done ? "Add a done status first." : "Add a status that is not done first.");
    const position = await nextPosition(ctx.db, "planning_tasks", ["status_id", target.id]);
    return patchTask(ctx, id, { statusId: target.id, position });
  }), (t) => t.id);
}

export async function deleteTask(id: string): Promise<WithActivity<PlanningResult<null>>> {
  let used: Db | undefined;
  const result = await mirrored("task", act(async (ctx) => {
    const db = (used = ctx.db);
    await none(db.from("planning_tasks").delete().eq("id", planId(id)));
    return null;
  }), () => id, true);
  return withActivity(result, used);
}

/** Null stops the repeat. A repeat needs a due date: an undated task is dated today. */
export async function setTaskRepeat(id: string, rule: RepeatRule | null): Promise<PlanningResult<PlanningTask>> {
  return mirrored("task", act((ctx) => patchTask(ctx, id, { repeatRule: rule })), (t) => t.id);
}

export async function setTaskAlert(id: string, alertAt: string): Promise<PlanningResult<PlanningTask>> {
  return act((ctx) => patchTask(ctx, id, { alertAt: parse(isoInstantSchema, alertAt) }));
}

export async function clearTaskAlert(id: string): Promise<PlanningResult<PlanningTask>> {
  return act((ctx) => patchTask(ctx, id, { alertAt: null }));
}

// ── goals ───────────────────────────────────────────────────────────────

async function getGoal(db: Db, id: string): Promise<PlanningGoal> {
  const [goal, metrics, links] = await Promise.all([
    one<PlanningGoalRow>(db.from("planning_goals").select("*").eq("id", id).maybeSingle()),
    db.from("planning_goal_metrics").select("*").eq("goal_id", id),
    db.from("planning_goal_links").select("*").eq("goal_id", id),
  ]);
  check(metrics.error);
  check(links.error);
  return toGoal(goal, metrics.data as PlanningGoalMetricRow[], links.data as PlanningGoalLinkRow[]);
}

export async function createGoal(input: CreateGoalInput): Promise<PlanningResult<PlanningGoal>> {
  return act(async ({ db }) => {
    const g = parse(createGoalSchema, input);
    await none(
      db.from("planning_goals").upsert(
        { id: g.id, title: g.title, position: g.position, category: g.category, start_date: g.startDate, deadline: g.deadline },
        { onConflict: "id", ignoreDuplicates: true },
      ),
    );
    return getGoal(db, g.id);
  });
}

export async function updateGoal(id: string, patch: GoalPatch): Promise<PlanningResult<PlanningGoal>> {
  return act(async (ctx) => {
    planId(id);
    const { achieved, ...rest } = parse(goalPatchSchema, patch);
    const columns = toColumns(rest, {
      title: "title",
      notes: "notes",
      category: "category",
      startDate: "start_date",
      deadline: "deadline",
      position: "position",
    });
    if (achieved !== undefined) columns.achieved_at = achieved ? ctx.now().toISOString() : null;
    if (Object.keys(columns).length > 0) {
      await one<PlanningGoalRow>(ctx.db.from("planning_goals").update(columns).eq("id", id).select("*").maybeSingle());
    }
    return getGoal(ctx.db, id);
  });
}

export async function deleteGoal(id: string): Promise<WithActivity<PlanningResult<null>>> {
  let used: Db | undefined;
  const result = await act(async (ctx) => {
    const db = (used = ctx.db);
    await none(db.from("planning_goals").delete().eq("id", planId(id)));
    return null;
  });
  return withActivity(result, used);
}

/** ponytail: one update per goal (a handful), not atomic; goal order is cosmetic. */
export async function setGoalPositions(updates: readonly PositionUpdate[]): Promise<PlanningResult<null>> {
  return act(async ({ db }) => {
    const items = parse(positionUpdatesSchema, updates);
    await Promise.all(items.map((u) => none(db.from("planning_goals").update({ position: u.position }).eq("id", u.id))));
    return null;
  });
}

export async function addGoalMetric(input: GoalMetricInput): Promise<PlanningResult<GoalMetric>> {
  return act(async ({ db }) => {
    const m = parse(goalMetricInputSchema, input);
    const position = await nextPosition(db, "planning_goal_metrics", ["goal_id", m.goalId]);
    return toMetric(
      await one<PlanningGoalMetricRow>(
        db
          .from("planning_goal_metrics")
          .insert({ id: m.id, goal_id: m.goalId, metric: m.metric, target: m.target, param: m.param, position })
          .select("*")
          .maybeSingle(),
      ),
    );
  });
}

export async function updateGoalMetric(id: string, patch: GoalMetricPatch): Promise<PlanningResult<GoalMetric>> {
  return act(async ({ db }) =>
    toMetric(
      await one<PlanningGoalMetricRow>(
        db.from("planning_goal_metrics").update(parse(goalMetricPatchSchema, patch)).eq("id", planId(id)).select("*").maybeSingle(),
      ),
    ),
  );
}

export async function removeGoalMetric(id: string): Promise<WithActivity<PlanningResult<null>>> {
  let used: Db | undefined;
  const result = await act(async (ctx) => {
    const db = (used = ctx.db);
    await none(db.from("planning_goal_metrics").delete().eq("id", planId(id)));
    return null;
  });
  return withActivity(result, used);
}

export async function addGoalLink(input: GoalLinkInput): Promise<PlanningResult<GoalLink>> {
  return act(async ({ db }) => {
    const l = parse(goalLinkInputSchema, input);
    const position = await nextPosition(db, "planning_goal_links", ["goal_id", l.goalId]);
    return toLink(
      await one<PlanningGoalLinkRow>(
        db.from("planning_goal_links").insert({ id: l.id, goal_id: l.goalId, url: l.url, title: l.title, position }).select("*").maybeSingle(),
      ),
    );
  });
}

export async function updateGoalLink(id: string, patch: GoalLinkPatch): Promise<PlanningResult<GoalLink>> {
  return act(async ({ db }) =>
    toLink(
      await one<PlanningGoalLinkRow>(
        db.from("planning_goal_links").update(parse(goalLinkPatchSchema, patch)).eq("id", planId(id)).select("*").maybeSingle(),
      ),
    ),
  );
}

export async function removeGoalLink(id: string): Promise<WithActivity<PlanningResult<null>>> {
  let used: Db | undefined;
  const result = await act(async (ctx) => {
    const db = (used = ctx.db);
    await none(db.from("planning_goal_links").delete().eq("id", planId(id)));
    return null;
  });
  return withActivity(result, used);
}

// ── events ──────────────────────────────────────────────────────────────

const EVENT_COLUMNS = {
  title: "title",
  startsAt: "starts_at",
  endsAt: "ends_at",
  allDay: "all_day",
  category: "category",
  repeat: "repeat",
  notes: "notes",
  alertAt: "alert_at",
} as const;

async function patchEvent(db: Db, id: string, rawPatch: unknown): Promise<PlanningEvent> {
  planId(id);
  const patch = parse(eventPatchSchema, rawPatch);
  return toEvent(await one<EventRow>(db.from("events").update(toColumns(patch, EVENT_COLUMNS)).eq("id", id).select("*").maybeSingle()));
}

export async function createEvent(input: CreateEventInput): Promise<PlanningResult<PlanningEvent>> {
  return mirrored("event", act(async ({ db }) => {
    const e = parse(createEventSchema, input);
    await none(
      db.from("events").upsert(
        {
          id: e.id,
          title: e.title,
          starts_at: e.startsAt,
          ends_at: e.endsAt,
          all_day: e.allDay,
          category: e.category,
          repeat: e.repeat,
          notes: e.notes,
          alert_at: e.alertAt,
        },
        { onConflict: "id", ignoreDuplicates: true },
      ),
    );
    return toEvent(await one<EventRow>(db.from("events").select("*").eq("id", e.id).maybeSingle()));
  }), (e) => e.id);
}

export async function updateEvent(id: string, patch: EventPatch): Promise<PlanningResult<PlanningEvent>> {
  return mirrored("event", act(({ db }) => patchEvent(db, id, patch)), (e) => e.id);
}

export async function deleteEvent(id: string): Promise<WithActivity<PlanningResult<null>>> {
  let used: Db | undefined;
  const result = await mirrored("event", act(async (ctx) => {
    const db = (used = ctx.db);
    await none(db.from("events").delete().eq("id", planId(id)));
    return null;
  }), () => id, true);
  return withActivity(result, used);
}

export async function setEventAlert(id: string, alertAt: string): Promise<PlanningResult<PlanningEvent>> {
  return mirrored("event", act(({ db }) => patchEvent(db, id, { alertAt: parse(isoInstantSchema, alertAt) })), (e) => e.id);
}

export async function clearEventAlert(id: string): Promise<PlanningResult<PlanningEvent>> {
  return act(({ db }) => patchEvent(db, id, { alertAt: null }));
}

// ── statuses ────────────────────────────────────────────────────────────

export async function createStatus(input: CreateStatusInput): Promise<PlanningResult<PlanningStatus>> {
  return act(async ({ db }) => {
    const s = parse(createStatusSchema, input);
    return toStatus(
      await one<PlanningStatusRow>(
        db.rpc("planning_create_status", { p_id: s.id, p_label: s.label, p_color: s.color, p_is_done: s.isDone }).maybeSingle(),
      ),
    );
  });
}

/** Returns its activity: flipping isDone rewrites completed_at on every task in the status, and the activity undo puts them back. */
export async function updateStatus(id: string, patch: StatusPatch): Promise<WithActivity<PlanningResult<PlanningStatus>>> {
  let used: Db | undefined;
  const result = await act(async (ctx) => {
    const db = (used = ctx.db);
    return toStatus(
      await one<PlanningStatusRow>(
        db
          .from("planning_statuses")
          .update(toColumns(parse(statusPatchSchema, patch), { label: "label", color: "color", isDone: "is_done" }))
          .eq("id", planId(id))
          .select("*")
          .maybeSingle(),
      ),
    );
  });
  return withActivity(result, used);
}

// ── category colors ─────────────────────────────────────────────────────

/** Upsert the category's color, or delete its row when the color is null. */
export async function setCategoryColor(category: string, color: string | null): Promise<PlanningResult<CategoryColor>> {
  return act(async ({ db }) => {
    const c = parse(categoryColorSchema, { category, color });
    const hex = c.color?.toLowerCase() ?? null;
    if (hex === null) await none(db.from("planning_category_colors").delete().eq("category", c.category));
    else
      await none(
        db
          .from("planning_category_colors")
          .upsert({ category: c.category, color: hex, updated_at: new Date().toISOString() }, { onConflict: "category" }),
      );
    return { category: c.category, color: hex };
  });
}

export async function reorderStatuses(orderedIds: readonly string[]): Promise<PlanningResult<null>> {
  return act(async ({ db }) => {
    await none(db.rpc("planning_reorder_statuses", { p_ids: parse(statusOrderSchema, orderedIds) }));
    return null;
  });
}

export async function deleteStatus(id: string, moveTo: string | null): Promise<WithActivity<PlanningResult<null>>> {
  let used: Db | undefined;
  const result = await act(async (ctx) => {
    const db = (used = ctx.db);
    await none(db.rpc("planning_delete_status", { p_status: planId(id), p_move_to: moveTo === null ? null : planId(moveTo) }));
    return null;
  });
  return withActivity(result, used);
}

// ── properties ──────────────────────────────────────────────────────────

async function getProperty(db: Db, id: string): Promise<PlanningProperty> {
  const [prop, options] = await Promise.all([
    one<PlanningPropertyRow>(db.from("planning_properties").select("*").eq("id", id).maybeSingle()),
    db.from("planning_property_options").select("*").eq("property_id", id),
  ]);
  check(options.error);
  return toProperty(prop, options.data as PlanningPropertyOptionRow[]);
}

export async function createProperty(input: PropertyInput): Promise<PlanningResult<PlanningProperty>> {
  return act(async ({ db }) => {
    const p = parse(propertyInputSchema, input);
    await none(
      db.from("planning_properties").insert({
        id: p.id,
        name: p.name,
        type: p.type,
        ...(p.numberFormat ? { number_format: p.numberFormat } : {}),
        ...(p.showOnBoard !== undefined ? { show_on_board: p.showOnBoard } : {}),
        ...(p.showInList !== undefined ? { show_in_list: p.showInList } : {}),
      }),
    );
    return getProperty(db, p.id);
  });
}

export async function updateProperty(id: string, patch: PropertyPatch): Promise<PlanningResult<PlanningProperty>> {
  return act(async ({ db }) => {
    planId(id);
    const columns = toColumns(parse(propertyPatchSchema, patch), {
      name: "name",
      numberFormat: "number_format",
      showOnBoard: "show_on_board",
      showInList: "show_in_list",
    });
    await one<PlanningPropertyRow>(db.from("planning_properties").update(columns).eq("id", id).select("*").maybeSingle());
    return getProperty(db, id);
  });
}

export async function reorderProperties(orderedIds: readonly string[]): Promise<PlanningResult<null>> {
  return act(async ({ db }) => {
    await none(db.rpc("planning_reorder_properties", { p_ids: parse(idOrderSchema, orderedIds) }));
    return null;
  });
}

export async function deleteProperty(id: string): Promise<WithActivity<PlanningResult<null>>> {
  let used: Db | undefined;
  const result = await act(async (ctx) => {
    const db = (used = ctx.db);
    await none(db.from("planning_properties").delete().eq("id", planId(id)));
    return null;
  });
  return withActivity(result, used);
}

export async function createOption(input: OptionInput): Promise<PlanningResult<PlanningOption>> {
  return act(async ({ db }) => {
    const o = parse(optionInputSchema, input);
    return toOption(
      await one<PlanningPropertyOptionRow>(
        db
          .from("planning_property_options")
          .insert({ id: o.id, property_id: o.propertyId, label: o.label, color: o.color })
          .select("*")
          .maybeSingle(),
      ),
    );
  });
}

export async function updateOption(id: string, patch: OptionPatch): Promise<PlanningResult<PlanningOption>> {
  return act(async ({ db }) =>
    toOption(
      await one<PlanningPropertyOptionRow>(
        db.from("planning_property_options").update(parse(optionPatchSchema, patch)).eq("id", planId(id)).select("*").maybeSingle(),
      ),
    ),
  );
}

export async function reorderOptions(propertyId: string, orderedIds: readonly string[]): Promise<PlanningResult<null>> {
  return act(async ({ db }) => {
    await none(db.rpc("planning_reorder_options", { p_property: planId(propertyId), p_ids: parse(idOrderSchema, orderedIds) }));
    return null;
  });
}

export async function deleteOption(id: string): Promise<WithActivity<PlanningResult<null>>> {
  let used: Db | undefined;
  const result = await act(async (ctx) => {
    const db = (used = ctx.db);
    await none(db.from("planning_property_options").delete().eq("id", planId(id)));
    return null;
  });
  return withActivity(result, used);
}

/** Null clears the value (its row is deleted). The reply is the saved value (null: cleared). */
export async function setTaskValue(
  taskId: string,
  propertyId: string,
  value: PropertyValue | null,
): Promise<PlanningResult<PropertyValue | null>> {
  return act(async ({ db }) => {
    planId(taskId);
    planId(propertyId);
    const v = parse(propertyValueSchema, value);
    if (v === null) {
      await none(db.from("planning_task_values").delete().eq("task_id", taskId).eq("property_id", propertyId));
      return null;
    }
    const prop = await one<Pick<PlanningPropertyRow, "type">>(
      db.from("planning_properties").select("type").eq("id", propertyId).maybeSingle(),
    );
    if (prop.type !== v.type) throw new PlanningError("That value does not fit this property.");
    await none(
      db.from("planning_task_values").upsert({ task_id: taskId, property_id: propertyId, ...valueToColumns(v) }, { onConflict: "task_id,property_id" }),
    );
    return v;
  });
}

/** How many tasks have a value of this property, or use this option. */
export async function propertyUsage(propertyOrOptionId: string): Promise<PlanningResult<number>> {
  return act(async ({ db }) => {
    const id = planId(propertyOrOptionId);
    const [byProperty, byOption] = await Promise.all([
      db.from("planning_task_values").select("task_id", { count: "exact", head: true }).eq("property_id", id),
      db.from("planning_task_values").select("task_id", { count: "exact", head: true }).contains("option_ids", [id]),
    ]);
    check(byProperty.error);
    check(byOption.error);
    return (byProperty.count ?? 0) + (byOption.count ?? 0);
  });
}
