"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";

import { offerUndo } from "@/components/activity/undo-bar";
import { drawerHref, setDrawerUrl } from "@/components/kit";
import { todayIn } from "@/lib/planning/dates";
import { defaultMetricRegistry, type MetricKey, type MetricRegistry } from "@/lib/planning/metrics";
import { POSITION_STEP } from "@/lib/planning/ordering";
import type { PlanningProperty, PropertyType, PropertyValue } from "@/lib/planning/properties";
import type { RepeatRule } from "@/lib/planning/repeat";
import type { GoalPatch, TaskPatch } from "@/lib/planning/schemas";
import { applyTaskPatch, categoryColorOf, completedAtFor, withCategoryColor, placeAmong, statusForDone, tasksInStatus } from "@/lib/planning/tasks";
import type { GoalLink, GoalMetric, PlanningActions, PlanningGoal, PlanningResult, PlanningSnapshot, PlanningTask } from "@/lib/planning/types";

import { measure, settle } from "./drag-motion";

/**
 * The Planning client store: the snapshot, optimistic writes with rollback, and the open drawer
 * (from the URL: `?task=`, `?goal=`). Every write goes through `PlanningActions`, so the same
 * components run on server actions (the Planning page, U14) and on memory (/dev/planning).
 *
 * A write shows at once. If the server refuses it, the change is undone and `error` says why.
 * Writes to one task carry a sequence number: a slow reply to an old write never overwrites a
 * newer one.
 */
export interface PlanningStore {
  readonly snapshot: PlanningSnapshot;
  /** The owner's today (yyyy-mm-dd). Frozen when the provider gets a fixed `now`. */
  readonly today: string;
  readonly timeZone: string;
  readonly registry: MetricRegistry;
  now(): Date;
  /** The last refused write, in words. Clears itself. */
  readonly error: string | null;
  dismissError(): void;

  readonly openTaskId: string | null;
  readonly openGoalId: string | null;
  openTask(id: string | null): void;
  openGoal(id: string | null): void;

  createTask(input: { title: string; statusId: string; goalId?: string | null; category?: string | null; dueDate?: string | null }): Promise<string | null>;
  updateTask(id: string, patch: TaskPatch): Promise<boolean>;
  moveTask(id: string, to: { statusId: string; afterId?: string | null; beforeId?: string | null }): Promise<boolean>;
  completeTask(id: string, done: boolean): Promise<boolean>;
  deleteTask(id: string): Promise<boolean>;
  setRepeat(id: string, rule: RepeatRule | null): Promise<boolean>;
  /** An ISO instant sets the alert; null clears it. */
  setAlert(id: string, alertAt: string | null): Promise<boolean>;
  setTaskValue(taskId: string, propertyId: string, value: PropertyValue | null): Promise<boolean>;
  createProperty(input: { name: string; type: PropertyType }): Promise<string | null>;
  createOption(propertyId: string, label: string): Promise<string | null>;
  /** Recolor a status (board column) or a select option; undone if the server refuses. */
  setStatusColor(id: string, color: string): Promise<boolean>;
  setOptionColor(propertyId: string, optionId: string, color: string): Promise<boolean>;
  /** Color a category (null: no color); undone if the server refuses. */
  setCategoryColor(category: string, color: string | null): Promise<boolean>;

  createGoal(input: { title: string; category?: string | null; deadline?: string | null }): Promise<string | null>;
  updateGoal(id: string, patch: GoalPatch): Promise<boolean>;
  deleteGoal(id: string): Promise<boolean>;
  addMetric(goalId: string, input: { metric: MetricKey; target: number; param?: string | null }): Promise<boolean>;
  updateMetric(id: string, patch: { target?: number; param?: string }): Promise<boolean>;
  removeMetric(id: string): Promise<boolean>;
  addLink(goalId: string, input: { url: string; title?: string | null }): Promise<boolean>;
  removeLink(id: string): Promise<boolean>;
}

const Ctx = createContext<PlanningStore | null>(null);

export function usePlanning(): PlanningStore {
  const store = useContext(Ctx);
  if (!store) throw new Error("usePlanning needs a PlanningProvider");
  return store;
}

const uuid = (): string => globalThis.crypto.randomUUID();

const COLOR_ON_NEW_OPTION = ["#1d1d1f", "#424245", "#6e6e73", "#a1a1a6", "#d2d2d7"];

export function PlanningProvider({
  initial,
  actions,
  now: fixedNow,
  registry = defaultMetricRegistry,
  children,
}: {
  initial: PlanningSnapshot;
  actions: PlanningActions;
  /** ISO instant. Freezes the clock (fixtures, tests). Omit for the real one. */
  now?: string;
  registry?: MetricRegistry;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const [snapshot, setSnapshot] = useState(initial);
  // The latest snapshot, readable between renders: two writes in one tick both see the first.
  const snap = useRef(initial);
  const apply = useCallback((fn: (s: PlanningSnapshot) => PlanningSnapshot) => {
    snap.current = fn(snap.current);
    setSnapshot(snap.current);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(new Map<string, number>());
  const clock = useCallback((): Date => (fixedNow ? new Date(fixedNow) : new Date()), [fixedNow]);

  // Real clock only: re-read today when the tab comes back, so a tab left open overnight rolls over.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (fixedNow) return;
    const onShow = () => document.visibilityState === "visible" && setTick((n) => n + 1);
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [fixedNow]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` is the trigger
  const today = useMemo(() => todayIn(clock(), snapshot.timeZone), [clock, snapshot.timeZone, tick]);

  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(t);
  }, [error]);

  const fail = useCallback(<T,>(r: PlanningResult<T>): r is Extract<PlanningResult<T>, { ok: false }> => {
    if (r.ok) return false;
    setError(r.error);
    return true;
  }, []);

  const patchTasks = useCallback(
    (fn: (t: PlanningTask) => PlanningTask, ids: readonly string[]) => {
      const set = new Set(ids);
      apply((s) => ({ ...s, tasks: s.tasks.map((t) => (set.has(t.id) ? fn(t) : t)) }));
    },
    [apply],
  );

  const bump = (id: string): number => {
    const n = (seq.current.get(id) ?? 0) + 1;
    seq.current.set(id, n);
    return n;
  };
  const latest = (id: string, n: number): boolean => seq.current.get(id) === n;

  const url = useCallback(
    (param: "task" | "goal", id: string | null) => {
      const next = new URLSearchParams(search.toString());
      // One panel at a time.
      next.delete("task");
      next.delete("goal");
      if (id === null) {
        const qs = next.toString();
        setDrawerUrl(qs ? `${pathname}?${qs}` : pathname);
      } else {
        setDrawerUrl(drawerHref(pathname, next, param, id), true);
      }
    },
    [pathname, search],
  );

  const store = useMemo<PlanningStore>(() => {
    const updateTask: PlanningStore["updateTask"] = async (id, patch) => {
      const before = snap.current.tasks.find((t) => t.id === id);
      if (!before) return false;
      const n = bump(id);
      patchTasks((t) => applyTaskPatch(t, patch, snap.current.statuses, clock(), todayIn(clock(), snap.current.timeZone)), [id]);
      const r = await actions.updateTask(id, patch);
      if (fail(r)) {
        if (latest(id, n)) patchTasks(() => before, [id]);
        return false;
      }
      if (latest(id, n)) patchTasks((t) => ({ ...r.value, values: t.values }), [id]);
      return true;
    };

    const moveTask: PlanningStore["moveTask"] = async (id, to) => {
      const s = snap.current;
      const task = s.tasks.find((t) => t.id === id);
      if (!task) return false;
      const rows = tasksInStatus(s.tasks, to.statusId).filter((t) => t.id !== id);
      const { position, renormalized } = placeAmong(rows, id, to.afterId, to.beforeId);
      const moved = to.statusId !== task.statusId;
      const updates = [
        ...(renormalized ?? []).filter((u) => u.id !== id),
        { id, position, ...(moved ? { statusId: to.statusId } : {}) },
      ];
      const before = s.tasks.filter((t) => updates.some((u) => u.id === t.id));
      const ns = updates.map((u) => bump(u.id));
      apply((cur) => ({
        ...cur,
        tasks: cur.tasks.map((t) => {
          const u = updates.find((x) => x.id === t.id) as { id: string; position: number; statusId?: string } | undefined;
          if (!u) return t;
          const statusId = u.statusId ?? t.statusId;
          return { ...t, position: u.position, statusId, completedAt: completedAtFor(t, statusId, cur.statuses, clock()) };
        }),
      }));
      const r = await actions.setTaskPositions(updates);
      if (fail(r)) {
        const restore = new Map(before.filter((_, i) => latest(updates[i].id, ns[i])).map((t) => [t.id, t]));
        // The cards glide back to where they were, not jump there.
        const boxes = typeof document === "undefined" ? null : measure(document, "data-task-id");
        // Committed now: settle() measures on the next frame, and an update from here (after an await, not in an
        // event) could commit after that frame, so the cards jumped back instead (measured: 16 of 20 drops).
        flushSync(() => apply((cur) => ({ ...cur, tasks: cur.tasks.map((t) => restore.get(t.id) ?? t) })));
        if (boxes) settle({ root: document, attr: "data-task-id", dropped: "", lifted: null, before: boxes, reduced: matchMedia("(prefers-reduced-motion: reduce)").matches });
        return false;
      }
      return true;
    };

    const createTask: PlanningStore["createTask"] = async (input) => {
      const s = snap.current;
      const title = input.title.trim();
      if (!title) return null;
      const id = uuid();
      const position = Math.max(0, ...s.tasks.filter((t) => t.statusId === input.statusId).map((t) => t.position)) + POSITION_STEP;
      const stamp = clock().toISOString();
      const task: PlanningTask = {
        id,
        title,
        notes: "",
        statusId: input.statusId,
        goalId: input.goalId ?? null,
        category: input.category ?? null,
        dueDate: input.dueDate ?? null,
        position,
        alertAt: null,
        repeatRule: null,
        repeatSeriesId: null,
        createdAt: stamp,
        updatedAt: stamp,
        completedAt: s.statuses.find((x) => x.id === input.statusId)?.isDone ? stamp : null,
        values: {},
      };
      apply((cur) => ({ ...cur, tasks: [...cur.tasks, task] }));
      const r = await actions.createTask({
        id,
        title,
        statusId: input.statusId,
        position,
        goalId: task.goalId,
        category: task.category,
        dueDate: task.dueDate,
      });
      if (fail(r)) {
        apply((cur) => ({ ...cur, tasks: cur.tasks.filter((t) => t.id !== id) }));
        return null;
      }
      patchTasks((t) => ({ ...r.value, values: t.values }), [id]);
      return id;
    };

    const deleteTask: PlanningStore["deleteTask"] = async (id) => {
      const before = snap.current.tasks.find((t) => t.id === id);
      if (!before) return false;
      apply((cur) => ({ ...cur, tasks: cur.tasks.filter((t) => t.id !== id) }));
      const r = await actions.deleteTask(id);
      const putBack = () => apply((cur) => (cur.tasks.some((t) => t.id === id) ? cur : { ...cur, tasks: [...cur.tasks, before] }));
      if (fail(r)) {
        putBack();
        return false;
      }
      offerUndo(r.activityId, `task "${before.title}"`, putBack);
      return true;
    };

    const setTaskValue: PlanningStore["setTaskValue"] = async (taskId, propertyId, value) => {
      const before = snap.current.tasks.find((t) => t.id === taskId);
      if (!before) return false;
      const n = bump(taskId);
      const put = (v: PropertyValue | null) =>
        patchTasks((t) => {
          const values = { ...t.values };
          if (v === null) delete values[propertyId];
          else values[propertyId] = v;
          return { ...t, values };
        }, [taskId]);
      put(value);
      const r = await actions.setTaskValue(taskId, propertyId, value);
      if (fail(r)) {
        if (latest(taskId, n)) put(before.values[propertyId] ?? null);
        return false;
      }
      return true;
    };

    const createProperty: PlanningStore["createProperty"] = async ({ name, type }) => {
      const id = uuid();
      const property: PlanningProperty = {
        id,
        name: name.trim(),
        type,
        numberFormat: "number",
        position: snap.current.properties.length,
        showOnBoard: type === "select",
        showInList: true,
        options: [],
      };
      apply((cur) => ({ ...cur, properties: [...cur.properties, property] }));
      const r = await actions.createProperty({ id, name: name.trim(), type, showOnBoard: property.showOnBoard });
      if (fail(r)) {
        apply((cur) => ({ ...cur, properties: cur.properties.filter((p) => p.id !== id) }));
        return null;
      }
      apply((cur) => ({ ...cur, properties: cur.properties.map((p) => (p.id === id ? r.value : p)) }));
      return id;
    };

    const createOption: PlanningStore["createOption"] = async (propertyId, label) => {
      const prop = snap.current.properties.find((p) => p.id === propertyId);
      if (!prop) return null;
      const id = uuid();
      const color = COLOR_ON_NEW_OPTION[prop.options.length % COLOR_ON_NEW_OPTION.length];
      const r = await actions.createOption({ id, propertyId, label: label.trim(), color });
      if (fail(r)) return null;
      apply((cur) => ({
        ...cur,
        properties: cur.properties.map((p) => (p.id === propertyId ? { ...p, options: [...p.options, r.value] } : p)),
      }));
      return id;
    };

    const setStatusColor: PlanningStore["setStatusColor"] = async (id, color) => {
      const before = snap.current.statuses.find((x) => x.id === id);
      if (!before) return false;
      // Only the latest pick for this id rolls back, so an older failure cannot undo a newer color.
      const n = bump(`color:${id}`);
      const put = (c: string) => apply((cur) => ({ ...cur, statuses: cur.statuses.map((x) => (x.id === id ? { ...x, color: c } : x)) }));
      put(color);
      if (fail(await actions.updateStatus(id, { color }))) {
        if (latest(`color:${id}`, n)) put(before.color);
        return false;
      }
      return true;
    };

    const setOptionColor: PlanningStore["setOptionColor"] = async (propertyId, optionId, color) => {
      const before = snap.current.properties.find((p) => p.id === propertyId)?.options.find((o) => o.id === optionId);
      if (!before) return false;
      const n = bump(`color:${optionId}`);
      const put = (c: string) =>
        apply((cur) => ({
          ...cur,
          properties: cur.properties.map((p) =>
            p.id === propertyId ? { ...p, options: p.options.map((o) => (o.id === optionId ? { ...o, color: c } : o)) } : p,
          ),
        }));
      put(color);
      if (fail(await actions.updateOption(optionId, { color }))) {
        if (latest(`color:${optionId}`, n)) put(before.color);
        return false;
      }
      return true;
    };

    const setCategoryColor: PlanningStore["setCategoryColor"] = async (category, color) => {
      const before = categoryColorOf(snap.current, category);
      const n = bump(`color:category:${category}`);
      const put = (c: string | null) =>
        apply((cur) => ({ ...cur, categoryColors: withCategoryColor(cur.categoryColors, category, c) }));
      put(color);
      if (fail(await actions.setCategoryColor(category, color))) {
        if (latest(`color:category:${category}`, n)) put(before);
        return false;
      }
      return true;
    };

    const editGoal =(id: string, fn: (g: PlanningGoal) => PlanningGoal) =>
      apply((cur) => ({ ...cur, goals: cur.goals.map((g) => (g.id === id ? fn(g) : g)) }));

    return {
      snapshot,
      today,
      timeZone: snapshot.timeZone,
      registry,
      now: clock,
      error,
      dismissError: () => setError(null),
      openTaskId: search.get("task"),
      openGoalId: search.get("goal"),
      openTask: (id) => url("task", id),
      openGoal: (id) => url("goal", id),

      createTask,
      updateTask,
      moveTask,
      deleteTask,
      completeTask: async (id, done) => {
        const target = statusForDone(snap.current.statuses, done);
        if (!target) return false;
        const last = Math.max(0, ...snap.current.tasks.filter((t) => t.statusId === target.id).map((t) => t.position));
        return updateTask(id, { statusId: target.id, position: last + POSITION_STEP });
      },
      setRepeat: (id, rule) => updateTask(id, { repeatRule: rule }),
      setAlert: (id, alertAt) => updateTask(id, { alertAt }),
      setTaskValue,
      createProperty,
      createOption,
      setStatusColor,
      setOptionColor,
      setCategoryColor,

      createGoal: async ({ title, category = null, deadline = null }) => {
        const id = uuid();
        const stamp = clock().toISOString();
        const position = Math.max(0, ...snap.current.goals.map((g) => g.position)) + POSITION_STEP;
        const goal: PlanningGoal = {
          id,
          title: title.trim(),
          notes: "",
          category,
          startDate: null,
          deadline,
          position,
          achievedAt: null,
          createdAt: stamp,
          updatedAt: stamp,
          metrics: [],
          links: [],
        };
        apply((cur) => ({ ...cur, goals: [...cur.goals, goal] }));
        const r = await actions.createGoal({ id, title: goal.title, position, category, deadline });
        if (fail(r)) {
          apply((cur) => ({ ...cur, goals: cur.goals.filter((g) => g.id !== id) }));
          return null;
        }
        editGoal(id, () => r.value);
        return id;
      },
      updateGoal: async (id, patch) => {
        const before = snap.current.goals.find((g) => g.id === id);
        if (!before) return false;
        const { achieved, ...rest } = patch;
        editGoal(id, (g) => ({
          ...g,
          ...rest,
          achievedAt: achieved === undefined ? g.achievedAt : achieved ? clock().toISOString() : null,
        }));
        const r = await actions.updateGoal(id, patch);
        if (fail(r)) {
          editGoal(id, () => before);
          return false;
        }
        editGoal(id, () => r.value);
        return true;
      },
      deleteGoal: async (id) => {
        const before = snap.current;
        apply((cur) => ({
          ...cur,
          goals: cur.goals.filter((g) => g.id !== id),
          tasks: cur.tasks.map((t) => (t.goalId === id ? { ...t, goalId: null } : t)),
        }));
        const r = await actions.deleteGoal(id);
        if (fail(r)) {
          apply(() => before);
          return false;
        }
        const goal = before.goals.find((g) => g.id === id);
        const linked = new Set(before.tasks.filter((t) => t.goalId === id).map((t) => t.id));
        if (goal)
          offerUndo(r.activityId, `goal "${goal.title}"`, () =>
            apply((cur) => ({
              ...cur,
              goals: cur.goals.some((g) => g.id === id) ? cur.goals : [...cur.goals, goal],
              tasks: cur.tasks.map((t) => (linked.has(t.id) && t.goalId === null ? { ...t, goalId: id } : t)),
            })),
          );
        return true;
      },
      addMetric: async (goalId, { metric, target, param = null }) => {
        const r = await actions.addGoalMetric({ id: uuid(), goalId, metric, target, param });
        if (fail(r)) return false;
        editGoal(goalId, (g) => ({ ...g, metrics: [...g.metrics, r.value as GoalMetric] }));
        return true;
      },
      updateMetric: async (id, patch) => {
        const r = await actions.updateGoalMetric(id, patch);
        if (fail(r)) return false;
        apply((cur) => ({
          ...cur,
          goals: cur.goals.map((g) => (g.id === r.value.goalId ? { ...g, metrics: g.metrics.map((m) => (m.id === id ? r.value : m)) } : g)),
        }));
        return true;
      },
      removeMetric: async (id) => {
        const metric = snap.current.goals.flatMap((g) => g.metrics).find((m) => m.id === id);
        const r = await actions.removeGoalMetric(id);
        if (fail(r)) return false;
        apply((cur) => ({ ...cur, goals: cur.goals.map((g) => ({ ...g, metrics: g.metrics.filter((m) => m.id !== id) })) }));
        if (metric) offerUndo(r.activityId, "metric", () => editGoal(metric.goalId, (g) => (g.metrics.some((m) => m.id === id) ? g : { ...g, metrics: [...g.metrics, metric] })));
        return true;
      },
      addLink: async (goalId, { url: href, title = null }) => {
        const r = await actions.addGoalLink({ id: uuid(), goalId, url: href, title });
        if (fail(r)) return false;
        editGoal(goalId, (g) => ({ ...g, links: [...g.links, r.value as GoalLink] }));
        return true;
      },
      removeLink: async (id) => {
        const link = snap.current.goals.flatMap((g) => g.links).find((l) => l.id === id);
        const r = await actions.removeGoalLink(id);
        if (fail(r)) return false;
        apply((cur) => ({ ...cur, goals: cur.goals.map((g) => ({ ...g, links: g.links.filter((l) => l.id !== id) })) }));
        if (link) offerUndo(r.activityId, "link", () => editGoal(link.goalId, (g) => (g.links.some((l) => l.id === id) ? g : { ...g, links: [...g.links, link] })));
        return true;
      },
    };
  }, [actions, apply, clock, error, fail, patchTasks, registry, search, snapshot, today, url]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
