import { useMemo, useRef, useState } from "react";

import type { Result, RoutineView, RoutinesActions, RoutinesData } from "@/components/routines/types";
import { describeSchedule, nextRun } from "@/lib/agent/schedule";

import { NOW, TZ } from "./fixture-data";

const ok = (over: Partial<Extract<Result, { ok: true }>> = {}): Result => ({ ok: true, ...over });

/**
 * The Routines actions on in-memory data, for /dev/routines. Same shapes as the live ones (the agent's routine
 * tools, the confirm and undo routes); "Run now" is mocked: it queues a run and nothing runs. A reload starts over.
 */
export function useMemoryRoutines(initial: RoutinesData) {
  const [data, setData] = useState(initial);
  const next = useRef(100);
  const actions = useMemo<RoutinesActions>(() => {
    const now = new Date(NOW);
    const patch = (id: string, change: (r: RoutineView) => RoutineView) =>
      setData((d) => ({ ...d, routines: d.routines.map((r) => (r.id === id ? change(r) : r)) }));
    return {
      create: async (input) => {
        const id = `00000000-0000-4000-8000-${String(next.current++).padStart(12, "0")}`;
        const routine: RoutineView = {
          id,
          ...input,
          scheduleText: describeSchedule(input.schedule),
          paused: false,
          nextRunAt: nextRun(input.schedule, now, TZ).toISOString(),
          runs: [],
        };
        setData((d) => ({ ...d, routines: [...d.routines, routine] }));
        return ok({ id });
      },
      update: async (id, input) => {
        patch(id, (r) => ({ ...r, ...input, scheduleText: describeSchedule(input.schedule), nextRunAt: r.paused ? null : nextRun(input.schedule, now, TZ).toISOString() }));
        return ok();
      },
      setPaused: async (id, paused) => {
        patch(id, (r) => ({ ...r, paused, nextRunAt: paused ? null : nextRun(r.schedule, now, TZ).toISOString() }));
        return ok();
      },
      runNow: async (id) => {
        const runId = `run-${next.current++}`;
        patch(id, (r) => ({ ...r, runs: [{ id: runId, occurrenceAt: NOW, status: "queued", output: "", error: null, actions: [] }, ...r.runs] }));
        return ok();
      },
      remove: async (id) => {
        setData((d) => ({ ...d, routines: d.routines.filter((r) => r.id !== id), approvals: d.approvals.filter((a) => a.routineId !== id) }));
        return ok();
      },
      decide: async (approvalId, approve) => {
        setData((d) => {
          const a = d.approvals.find((x) => x.id === approvalId);
          if (!a) return d;
          const step = approve
            ? { status: "ok" as const, error: null, action: { id: `act-${next.current++}`, summary: a.summary, undoable: true, undone: false } }
            : { status: "failed" as const, error: "You declined this step.", action: null };
          return {
            ...d,
            approvals: d.approvals.filter((x) => x.id !== approvalId),
            routines: d.routines.map((r) =>
              r.id !== a.routineId
                ? r
                : { ...r, runs: r.runs.map((run) => (run.id !== a.runId ? run : { ...run, status: step.status, error: step.error, actions: step.action ? [...run.actions, step.action] : run.actions })) },
            ),
          };
        });
        return ok();
      },
      undo: async (actionId) => {
        setData((d) => ({
          ...d,
          routines: d.routines.map((r) => ({
            ...r,
            runs: r.runs.map((run) => ({ ...run, actions: run.actions.map((a) => (a.id === actionId ? { ...a, undoable: false, undone: true } : a)) })),
          })),
        }));
        return ok();
      },
    };
  }, []);
  return { data, actions };
}
