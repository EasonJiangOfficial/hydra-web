import { z } from "zod";

import { METRIC_KEYS } from "./metrics";
import { repeatRuleSchema } from "./repeat";

/** Input validation for every Planning write. The pages, the actions and the agent share these. */
export const planningIdSchema = z.uuid();
export const taskTitleSchema = z.string().trim().min(1).max(200);
export const goalTitleSchema = z.string().trim().min(1).max(200);
export const eventTitleSchema = z.string().trim().min(1).max(200);
export const statusLabelSchema = z.string().trim().min(1).max(60);
export const categorySchema = z.string().trim().min(1).max(60);
export const notesSchema = z.string().max(20000);
export const isoDateSchema = z.iso.date();
export const isoInstantSchema = z.iso.datetime({ offset: true });
export const colorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

const positionSchema = z.number().finite();
const atLeastOneKey = (value: object): boolean => Object.keys(value).length > 0;

/** The client picks the id, so a retried create is idempotent. */
export const createTaskSchema = z.object({
  id: planningIdSchema,
  title: taskTitleSchema,
  statusId: planningIdSchema,
  position: positionSchema,
  goalId: planningIdSchema.nullable().default(null),
  category: categorySchema.nullable().default(null),
  dueDate: isoDateSchema.nullable().default(null),
  alertAt: isoInstantSchema.nullable().default(null),
  repeatRule: repeatRuleSchema.nullable().default(null),
});
export type CreateTaskInput = z.input<typeof createTaskSchema>;

export const taskPatchSchema = z
  .strictObject({
    title: taskTitleSchema.optional(),
    notes: notesSchema.optional(),
    statusId: planningIdSchema.optional(),
    position: positionSchema.optional(),
    goalId: planningIdSchema.nullable().optional(),
    category: categorySchema.nullable().optional(),
    dueDate: isoDateSchema.nullable().optional(),
    repeatRule: repeatRuleSchema.nullable().optional(),
    alertAt: isoInstantSchema.nullable().optional(),
  })
  .refine(atLeastOneKey, "Empty patch");
export type TaskPatch = z.infer<typeof taskPatchSchema>;

export const createGoalSchema = z.object({
  id: planningIdSchema,
  title: goalTitleSchema,
  position: positionSchema,
  category: categorySchema.nullable().default(null),
  startDate: isoDateSchema.nullable().default(null),
  deadline: isoDateSchema.nullable().default(null),
});
export type CreateGoalInput = z.input<typeof createGoalSchema>;

export const goalPatchSchema = z
  .strictObject({
    title: goalTitleSchema.optional(),
    notes: notesSchema.optional(),
    category: categorySchema.nullable().optional(),
    startDate: isoDateSchema.nullable().optional(),
    deadline: isoDateSchema.nullable().optional(),
    position: positionSchema.optional(),
    achieved: z.boolean().optional(),
  })
  .refine(atLeastOneKey, "Empty patch");
export type GoalPatch = z.infer<typeof goalPatchSchema>;

export const metricKeySchema = z.enum(METRIC_KEYS);
const targetSchema = z.number().gt(0).max(1e11);

export const goalMetricInputSchema = z
  .object({
    id: planningIdSchema,
    goalId: planningIdSchema,
    metric: metricKeySchema,
    target: targetSchema,
    /** category_spend: the category. */
    param: categorySchema.nullable().default(null),
  })
  .refine((m) => (m.metric === "category_spend") === (m.param !== null), {
    message: "Only category spend takes a category, and it needs one",
    path: ["param"],
  })
  .refine((m) => m.metric !== "savings_rate" || m.target <= 100, {
    message: "A savings rate target is at most 100",
    path: ["target"],
  });
export type GoalMetricInput = z.input<typeof goalMetricInputSchema>;

export const goalMetricPatchSchema = z
  .strictObject({ target: targetSchema.optional(), param: categorySchema.optional() })
  .refine(atLeastOneKey, "Empty patch");
export type GoalMetricPatch = z.infer<typeof goalMetricPatchSchema>;

const urlSchema = z
  .string()
  .trim()
  .max(2000)
  .pipe(z.url({ protocol: /^https?$/ }));
export const goalLinkInputSchema = z.object({
  id: planningIdSchema,
  goalId: planningIdSchema,
  url: urlSchema,
  title: z.string().trim().min(1).max(200).nullable().default(null),
});
export type GoalLinkInput = z.input<typeof goalLinkInputSchema>;

export const goalLinkPatchSchema = z
  .strictObject({ url: urlSchema.optional(), title: z.string().trim().min(1).max(200).nullable().optional() })
  .refine(atLeastOneKey, "Empty patch");
export type GoalLinkPatch = z.infer<typeof goalLinkPatchSchema>;

export const createEventSchema = z
  .object({
    id: planningIdSchema,
    title: eventTitleSchema,
    startsAt: isoInstantSchema,
    endsAt: isoInstantSchema.nullable().default(null),
    allDay: z.boolean().default(false),
    category: categorySchema.nullable().default(null),
    repeat: repeatRuleSchema.nullable().default(null),
    notes: notesSchema.default(""),
    alertAt: isoInstantSchema.nullable().default(null),
  })
  .refine((e) => e.endsAt === null || new Date(e.endsAt) >= new Date(e.startsAt), {
    message: "An event cannot end before it starts",
    path: ["endsAt"],
  });
export type CreateEventInput = z.input<typeof createEventSchema>;

export const eventPatchSchema = z
  .strictObject({
    title: eventTitleSchema.optional(),
    startsAt: isoInstantSchema.optional(),
    endsAt: isoInstantSchema.nullable().optional(),
    allDay: z.boolean().optional(),
    category: categorySchema.nullable().optional(),
    repeat: repeatRuleSchema.nullable().optional(),
    notes: notesSchema.optional(),
    alertAt: isoInstantSchema.nullable().optional(),
  })
  .refine(atLeastOneKey, "Empty patch");
export type EventPatch = z.infer<typeof eventPatchSchema>;

/** The server picks the status position: after the last. */
export const createStatusSchema = z.object({
  id: planningIdSchema,
  label: statusLabelSchema,
  color: colorSchema,
  isDone: z.boolean(),
});
export type CreateStatusInput = z.infer<typeof createStatusSchema>;

export const statusPatchSchema = z
  .strictObject({
    label: statusLabelSchema.optional(),
    color: colorSchema.optional(),
    isDone: z.boolean().optional(),
  })
  .refine(atLeastOneKey, "Empty patch");
export type StatusPatch = z.infer<typeof statusPatchSchema>;

/** A category's color; null clears it (the category then has none). */
export const categoryColorSchema = z.object({ category: categorySchema, color: colorSchema.nullable() });
export type CategoryColor = z.infer<typeof categoryColorSchema>;

const positionUpdateSchema = z.object({ id: planningIdSchema, position: positionSchema });
export type PositionUpdate = z.infer<typeof positionUpdateSchema>;

export const positionUpdatesSchema = z.array(positionUpdateSchema).min(1).max(500).readonly();

/** A task move: statusId only on the task that changes column. */
const taskPositionUpdateSchema = positionUpdateSchema.extend({ statusId: planningIdSchema.optional() });
export type TaskPositionUpdate = z.infer<typeof taskPositionUpdateSchema>;

/** planning_set_task_positions refuses a repeated id, so refuse it first. */
export const taskPositionUpdatesSchema = z
  .array(taskPositionUpdateSchema)
  .min(1)
  .max(500)
  .refine((items) => new Set(items.map((i) => i.id)).size === items.length, "Duplicate task")
  .readonly();

export const statusOrderSchema = z
  .array(planningIdSchema)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate status");
