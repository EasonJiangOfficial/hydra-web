import { todayIn } from "./dates";
import {
  idOrderSchema,
  optionInputSchema,
  optionPatchSchema,
  propertyInputSchema,
  propertyPatchSchema,
  propertyValueSchema,
  type PlanningOption,
  type PlanningProperty,
  type PropertyValue,
} from "./properties";
import { PlanningError, parse, toResult } from "./result";
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
} from "./schemas";
import { applyTaskPatch, completedAtFor, statusForDone, withCategoryColor } from "./tasks";
import type {
  GoalLink,
  GoalMetric,
  PlanningActions,
  PlanningEvent,
  PlanningGoal,
  PlanningSnapshot,
  PlanningStatus,
  PlanningTask,
} from "./types";

/**
 * PlanningActions backed by memory. /dev/planning runs on it, and so do the UI tests: the same
 * names, inputs, validation and results as actions.ts, minus the database. It keeps the rules the
 * database keeps (completed_at follows the status, a repeat needs a due date, one metric per goal,
 * options belong to their property) so what the fixture page shows is what the real page will do.
 * Not modelled: repeat copies (the cron makes them) and alert delivery.
 */
export interface MemoryPlanning {
  readonly actions: PlanningActions;
  readonly snapshot: () => PlanningSnapshot;
}

const STEP = 1024;

export function createMemoryActions(
  initial: PlanningSnapshot,
  { now = () => new Date(), delayMs = 0 }: { now?: () => Date; delayMs?: number } = {},
): MemoryPlanning {
  let state: PlanningSnapshot = initial;
  const set = (patch: Partial<PlanningSnapshot>): void => {
    state = { ...state, ...patch };
  };
  const wait = (): Promise<void> => (delayMs ? new Promise((r) => setTimeout(r, delayMs)) : Promise.resolve());
  const run = async <T>(body: () => T | Promise<T>) => {
    await wait();
    return toResult(async () => body());
  };

  const taskOf = (id: string): PlanningTask => {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) throw new PlanningError("That task is gone.");
    return t;
  };
  const goalOf = (id: string): PlanningGoal => {
    const g = state.goals.find((x) => x.id === id);
    if (!g) throw new PlanningError("That item is gone.");
    return g;
  };
  const eventOf = (id: string): PlanningEvent => {
    const e = state.events.find((x) => x.id === id);
    if (!e) throw new PlanningError("That item is gone.");
    return e;
  };
  const putTask = (next: PlanningTask): PlanningTask => {
    set({ tasks: state.tasks.map((t) => (t.id === next.id ? next : t)) });
    return next;
  };
  const putGoal = (next: PlanningGoal): PlanningGoal => {
    set({ goals: state.goals.map((g) => (g.id === next.id ? next : g)) });
    return next;
  };
  const putEvent = (next: PlanningEvent): PlanningEvent => {
    set({ events: state.events.map((e) => (e.id === next.id ? next : e)) });
    return next;
  };
  const today = (): string => todayIn(now(), state.timeZone);
  const endOf = (rows: readonly { position: number }[]): number => Math.max(0, ...rows.map((r) => r.position)) + STEP;

  /** Apply a task patch the way the database would. */
  const patchTask = (id: string, raw: unknown): PlanningTask => {
    const patch = parse(taskPatchSchema, raw);
    const task = taskOf(id);
    if (patch.statusId && !state.statuses.some((s) => s.id === patch.statusId)) throw new PlanningError("That item is gone.");
    if (patch.goalId && !state.goals.some((g) => g.id === patch.goalId)) throw new PlanningError("That item is gone.");
    return putTask(applyTaskPatch(task, patch, state.statuses, now(), today()));
  };

  const patchEvent = (id: string, raw: unknown): PlanningEvent => {
    const p = parse(eventPatchSchema, raw);
    const e = eventOf(id);
    const next: PlanningEvent = {
      ...e,
      title: p.title ?? e.title,
      startsAt: p.startsAt ?? e.startsAt,
      endsAt: p.endsAt === undefined ? e.endsAt : p.endsAt,
      allDay: p.allDay ?? e.allDay,
      category: p.category === undefined ? e.category : p.category,
      repeat: p.repeat === undefined ? e.repeat : p.repeat,
      notes: p.notes ?? e.notes,
      alertAt: p.alertAt === undefined ? e.alertAt : p.alertAt,
      updatedAt: now().toISOString(),
    };
    if (next.endsAt && new Date(next.endsAt) < new Date(next.startsAt)) throw new PlanningError("An event cannot end before it starts.");
    return putEvent(next);
  };

  const propertyOf = (id: string): PlanningProperty => {
    const p = state.properties.find((x) => x.id === id);
    if (!p) throw new PlanningError("That item is gone.");
    return p;
  };
  const putProperty = (next: PlanningProperty): PlanningProperty => {
    set({ properties: state.properties.map((p) => (p.id === next.id ? next : p)) });
    return next;
  };

  const actions: PlanningActions = {
    loadPlanning: () => run(() => state),

    createTask: (input) =>
      run(() => {
        const t = parse(createTaskSchema, input);
        const existing = state.tasks.find((x) => x.id === t.id);
        if (existing) return existing;
        if (!state.statuses.some((s) => s.id === t.statusId)) throw new PlanningError("That item is gone.");
        const stamp = now().toISOString();
        const task: PlanningTask = {
          id: t.id,
          title: t.title,
          notes: "",
          statusId: t.statusId,
          goalId: t.goalId,
          category: t.category,
          dueDate: t.dueDate ?? (t.repeatRule ? today() : null),
          position: t.position,
          alertAt: t.alertAt,
          repeatRule: t.repeatRule,
          repeatSeriesId: t.repeatRule ? t.id : null,
          createdAt: stamp,
          updatedAt: stamp,
          completedAt: state.statuses.find((s) => s.id === t.statusId)?.isDone ? stamp : null,
          values: {},
        };
        set({ tasks: [...state.tasks, task] });
        return task;
      }),
    updateTask: (id, patch) => run(() => patchTask(id, patch)),
    setTaskPositions: (updates) =>
      run(() => {
        const items = parse(taskPositionUpdatesSchema, updates);
        for (const u of items) taskOf(u.id);
        for (const u of items) {
          const t = taskOf(u.id);
          const statusId = u.statusId ?? t.statusId;
          putTask({ ...t, position: u.position, statusId, completedAt: completedAtFor(t, statusId, state.statuses, now()) });
        }
        return null;
      }),
    completeTask: (id, done) =>
      run(() => {
        const target = statusForDone(state.statuses, done);
        if (!target) throw new PlanningError(done ? "Add a done status first." : "Add a status that is not done first.");
        const inTarget = state.tasks.filter((t) => t.statusId === target.id);
        return patchTask(id, { statusId: target.id, position: endOf(inTarget) });
      }),
    deleteTask: (id) =>
      run(() => {
        set({ tasks: state.tasks.filter((t) => t.id !== parse(planningIdSchema, id)) });
        return null;
      }),
    setTaskRepeat: (id, rule) => run(() => patchTask(id, { repeatRule: rule })),
    setTaskAlert: (id, alertAt) => run(() => patchTask(id, { alertAt: parse(isoInstantSchema, alertAt) })),
    clearTaskAlert: (id) => run(() => patchTask(id, { alertAt: null })),

    createGoal: (input) =>
      run(() => {
        const g = parse(createGoalSchema, input);
        const existing = state.goals.find((x) => x.id === g.id);
        if (existing) return existing;
        const stamp = now().toISOString();
        const goal: PlanningGoal = {
          id: g.id,
          title: g.title,
          notes: "",
          category: g.category,
          startDate: g.startDate,
          deadline: g.deadline,
          position: g.position,
          achievedAt: null,
          createdAt: stamp,
          updatedAt: stamp,
          metrics: [],
          links: [],
        };
        set({ goals: [...state.goals, goal] });
        return goal;
      }),
    updateGoal: (id, patch) =>
      run(() => {
        const { achieved, ...p } = parse(goalPatchSchema, patch);
        const g = goalOf(id);
        const next: PlanningGoal = {
          ...g,
          title: p.title ?? g.title,
          notes: p.notes ?? g.notes,
          category: p.category === undefined ? g.category : p.category,
          startDate: p.startDate === undefined ? g.startDate : p.startDate,
          deadline: p.deadline === undefined ? g.deadline : p.deadline,
          position: p.position ?? g.position,
          achievedAt: achieved === undefined ? g.achievedAt : achieved ? now().toISOString() : null,
          updatedAt: now().toISOString(),
        };
        if (next.startDate && next.deadline && next.startDate > next.deadline) {
          throw new PlanningError("The start date must be on or before the deadline.");
        }
        return putGoal(next);
      }),
    deleteGoal: (id) =>
      run(() => {
        goalOf(id);
        set({
          goals: state.goals.filter((g) => g.id !== id),
          tasks: state.tasks.map((t) => (t.goalId === id ? { ...t, goalId: null } : t)),
        });
        return null;
      }),
    setGoalPositions: (updates) =>
      run(() => {
        for (const u of parse(positionUpdatesSchema, updates)) putGoal({ ...goalOf(u.id), position: u.position });
        return null;
      }),
    addGoalMetric: (input) =>
      run(() => {
        const m = parse(goalMetricInputSchema, input);
        const g = goalOf(m.goalId);
        if (g.metrics.some((x) => x.metric === m.metric && (x.param ?? "") === (m.param ?? ""))) {
          throw new PlanningError("That metric is already on this goal.");
        }
        const metric: GoalMetric = { id: m.id, goalId: g.id, metric: m.metric, target: m.target, param: m.param, position: endOf(g.metrics) };
        putGoal({ ...g, metrics: [...g.metrics, metric] });
        return metric;
      }),
    updateGoalMetric: (id, patch) =>
      run(() => {
        const p = parse(goalMetricPatchSchema, patch);
        const g = state.goals.find((x) => x.metrics.some((m) => m.id === id));
        const m = g?.metrics.find((x) => x.id === id);
        if (!g || !m) throw new PlanningError("That item is gone.");
        const next: GoalMetric = { ...m, target: p.target ?? m.target, param: p.param ?? m.param };
        putGoal({ ...g, metrics: g.metrics.map((x) => (x.id === id ? next : x)) });
        return next;
      }),
    removeGoalMetric: (id) =>
      run(() => {
        set({ goals: state.goals.map((g) => ({ ...g, metrics: g.metrics.filter((m) => m.id !== id) })) });
        return null;
      }),
    addGoalLink: (input) =>
      run(() => {
        const l = parse(goalLinkInputSchema, input);
        const g = goalOf(l.goalId);
        const link: GoalLink = { id: l.id, goalId: g.id, url: l.url, title: l.title, position: endOf(g.links) };
        putGoal({ ...g, links: [...g.links, link] });
        return link;
      }),
    updateGoalLink: (id, patch) =>
      run(() => {
        const p = parse(goalLinkPatchSchema, patch);
        const g = state.goals.find((x) => x.links.some((l) => l.id === id));
        const l = g?.links.find((x) => x.id === id);
        if (!g || !l) throw new PlanningError("That item is gone.");
        const next: GoalLink = { ...l, url: p.url ?? l.url, title: p.title === undefined ? l.title : p.title };
        putGoal({ ...g, links: g.links.map((x) => (x.id === id ? next : x)) });
        return next;
      }),
    removeGoalLink: (id) =>
      run(() => {
        set({ goals: state.goals.map((g) => ({ ...g, links: g.links.filter((l) => l.id !== id) })) });
        return null;
      }),

    createEvent: (input) =>
      run(() => {
        const e = parse(createEventSchema, input);
        const existing = state.events.find((x) => x.id === e.id);
        if (existing) return existing;
        const stamp = now().toISOString();
        const event: PlanningEvent = { ...e, googleEventId: null, createdAt: stamp, updatedAt: stamp };
        set({ events: [...state.events, event] });
        return event;
      }),
    updateEvent: (id, patch) => run(() => patchEvent(id, patch)),
    deleteEvent: (id) =>
      run(() => {
        set({ events: state.events.filter((e) => e.id !== parse(planningIdSchema, id)) });
        return null;
      }),
    setEventAlert: (id, alertAt) => run(() => patchEvent(id, { alertAt: parse(isoInstantSchema, alertAt) })),
    clearEventAlert: (id) => run(() => patchEvent(id, { alertAt: null })),

    createStatus: (input) =>
      run(() => {
        const s = parse(createStatusSchema, input);
        const status: PlanningStatus = { id: s.id, label: s.label, color: s.color, isDone: s.isDone, position: state.statuses.length };
        set({ statuses: [...state.statuses, status] });
        return status;
      }),
    setCategoryColor: (category, color) =>
      run(() => {
        const c = parse(categoryColorSchema, { category, color });
        const hex = c.color?.toLowerCase() ?? null;
        set({ categoryColors: withCategoryColor(state.categoryColors, c.category, hex) });
        return { category: c.category, color: hex };
      }),
    updateStatus: (id, patch) =>
      run(() => {
        const p = parse(statusPatchSchema, patch);
        const s = state.statuses.find((x) => x.id === id);
        if (!s) throw new PlanningError("That item is gone.");
        const next: PlanningStatus = { ...s, label: p.label ?? s.label, color: p.color ?? s.color, isDone: p.isDone ?? s.isDone };
        set({
          statuses: state.statuses.map((x) => (x.id === id ? next : x)),
          tasks: state.tasks.map((t) =>
            t.statusId === id && next.isDone !== s.isDone ? { ...t, completedAt: next.isDone ? (t.completedAt ?? now().toISOString()) : null } : t,
          ),
        });
        return next;
      }),
    reorderStatuses: (ids) =>
      run(() => {
        const order = parse(statusOrderSchema, ids);
        if (order.length !== state.statuses.length || !state.statuses.every((s) => order.includes(s.id))) {
          throw new PlanningError("That list changed. Reload and try again.");
        }
        set({ statuses: state.statuses.map((s) => ({ ...s, position: order.indexOf(s.id) })) });
        return null;
      }),
    deleteStatus: (id, moveTo) =>
      run(() => {
        if (state.statuses.length <= 1) throw new PlanningError("A board needs at least one status.");
        const inUse = state.tasks.filter((t) => t.statusId === id);
        if (inUse.length > 0) {
          if (!moveTo || moveTo === id || !state.statuses.some((s) => s.id === moveTo)) throw new PlanningError("Move its tasks to another status first.");
          let at = endOf(state.tasks.filter((t) => t.statusId === moveTo));
          for (const t of [...inUse].sort((a, b) => a.position - b.position)) {
            putTask({ ...t, statusId: moveTo, position: at, completedAt: completedAtFor(t, moveTo, state.statuses, now()) });
            at += STEP;
          }
        }
        set({ statuses: state.statuses.filter((s) => s.id !== id) });
        return null;
      }),

    createProperty: (input) =>
      run(() => {
        const p = parse(propertyInputSchema, input);
        if (state.properties.some((x) => x.name.trim().toLowerCase() === p.name.toLowerCase())) {
          throw new PlanningError("A property with that name exists.");
        }
        const property: PlanningProperty = {
          id: p.id,
          name: p.name,
          type: p.type,
          numberFormat: p.numberFormat ?? "number",
          position: state.properties.length,
          showOnBoard: p.showOnBoard ?? true,
          showInList: p.showInList ?? true,
          options: [],
        };
        set({ properties: [...state.properties, property] });
        return property;
      }),
    updateProperty: (id, patch) =>
      run(() => {
        const p = parse(propertyPatchSchema, patch);
        const prop = propertyOf(id);
        return putProperty({
          ...prop,
          name: p.name ?? prop.name,
          numberFormat: p.numberFormat ?? prop.numberFormat,
          showOnBoard: p.showOnBoard ?? prop.showOnBoard,
          showInList: p.showInList ?? prop.showInList,
        });
      }),
    reorderProperties: (ids) =>
      run(() => {
        const order = parse(idOrderSchema, ids);
        if (order.length !== state.properties.length || !state.properties.every((p) => order.includes(p.id))) {
          throw new PlanningError("That list changed. Reload and try again.");
        }
        set({ properties: state.properties.map((p) => ({ ...p, position: order.indexOf(p.id) })).sort((a, b) => a.position - b.position) });
        return null;
      }),
    deleteProperty: (id) =>
      run(() => {
        propertyOf(id);
        set({
          properties: state.properties.filter((p) => p.id !== id),
          tasks: state.tasks.map((t) => {
            const values = { ...t.values };
            delete values[id];
            return { ...t, values };
          }),
        });
        return null;
      }),
    createOption: (input) =>
      run(() => {
        const o = parse(optionInputSchema, input);
        const prop = propertyOf(o.propertyId);
        if (prop.type !== "select" && prop.type !== "multi_select") throw new PlanningError("That value does not fit this property.");
        if (prop.options.some((x) => x.label.toLowerCase() === o.label.toLowerCase())) throw new PlanningError("An option with that name exists.");
        const option: PlanningOption = { id: o.id, label: o.label, color: o.color, position: prop.options.length };
        putProperty({ ...prop, options: [...prop.options, option] });
        return option;
      }),
    updateOption: (id, patch) =>
      run(() => {
        const p = parse(optionPatchSchema, patch);
        const prop = state.properties.find((x) => x.options.some((o) => o.id === id));
        const o = prop?.options.find((x) => x.id === id);
        if (!prop || !o) throw new PlanningError("That item is gone.");
        const next = { ...o, label: p.label ?? o.label, color: p.color ?? o.color };
        putProperty({ ...prop, options: prop.options.map((x) => (x.id === id ? next : x)) });
        return next;
      }),
    reorderOptions: (propertyId, ids) =>
      run(() => {
        const prop = propertyOf(propertyId);
        const order = parse(idOrderSchema, ids);
        if (order.length !== prop.options.length || !prop.options.every((o) => order.includes(o.id))) {
          throw new PlanningError("That list changed. Reload and try again.");
        }
        putProperty({
          ...prop,
          options: order.map((oid, i) => ({ ...(prop.options.find((o) => o.id === oid) as PlanningOption), position: i })),
        });
        return null;
      }),
    deleteOption: (id) =>
      run(() => {
        set({
          properties: state.properties.map((p) => ({ ...p, options: p.options.filter((o) => o.id !== id) })),
          tasks: state.tasks.map((t) => {
            const values = { ...t.values };
            for (const [pid, v] of Object.entries(values)) {
              if (v.type === "select" && v.optionId === id) delete values[pid];
              else if (v.type === "multi_select" && v.optionIds.includes(id)) {
                const left = v.optionIds.filter((x) => x !== id);
                if (left.length === 0) delete values[pid];
                else values[pid] = { type: "multi_select", optionIds: left };
              }
            }
            return { ...t, values };
          }),
        });
        return null;
      }),
    setTaskValue: (taskId, propertyId, value) =>
      run((): PropertyValue | null => {
        const v = parse(propertyValueSchema, value);
        const task = taskOf(taskId);
        const prop = propertyOf(propertyId);
        const values = { ...task.values };
        if (v === null) delete values[propertyId];
        else {
          if (v.type !== prop.type) throw new PlanningError("That value does not fit this property.");
          const ids = v.type === "select" ? [v.optionId] : v.type === "multi_select" ? v.optionIds : [];
          if (!ids.every((oid) => prop.options.some((o) => o.id === oid))) throw new PlanningError("That value does not fit this property.");
          values[propertyId] = v;
        }
        putTask({ ...task, values });
        return v;
      }),
    propertyUsage: (id) =>
      run(() =>
        state.tasks.filter((t) =>
          Object.entries(t.values).some(
            ([pid, v]) => pid === id || (v.type === "select" && v.optionId === id) || (v.type === "multi_select" && v.optionIds.includes(id)),
          ),
        ).length,
      ),
  };

  return { actions, snapshot: () => state };
}
