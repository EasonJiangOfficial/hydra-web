import { describeSchedule, type Schedule } from "@/lib/agent/schedule";
import type { ActionRow, ApprovalRow, RoutineRow, RunRow } from "@/lib/agent/store";

import type { ActionView, RoutinesData } from "./types";

/** Server rows to what the page shows. Pure, so the live page and a test build the same thing. */
export function buildRoutinesData(rows: {
  now: Date;
  timeZone: string;
  routines: RoutineRow[];
  runs: RunRow[];
  actions: ActionRow[];
  approvals: ApprovalRow[];
}): RoutinesData {
  const actions = new Map<string, ActionView>(
    rows.actions.map((a) => [a.id, { id: a.id, summary: a.summary, undoable: a.inverse !== null && a.undone_at === null, undone: a.undone_at !== null }]),
  );
  const routines = rows.routines.map((r) => ({
    id: r.id,
    name: r.name,
    instruction: r.instruction,
    schedule: r.schedule as Schedule,
    scheduleText: describeSchedule(r.schedule as Schedule),
    tools: r.tools,
    delivery: r.delivery,
    whenMacOff: r.when_mac_off,
    paused: r.paused,
    nextRunAt: r.paused ? null : r.next_run_at,
    runs: rows.runs
      .filter((run) => run.routine_id === r.id)
      .slice(0, 20)
      .map((run) => ({
        id: run.id,
        occurrenceAt: run.occurrence_at,
        status: run.status,
        output: run.output,
        error: run.error,
        actions: run.action_ids.flatMap((id) => actions.get(id) ?? []),
      })),
  }));
  const runToRoutine = new Map(rows.runs.map((run) => [run.id, run.routine_id]));
  const names = new Map(rows.routines.map((r) => [r.id, r.name]));
  return {
    now: rows.now.toISOString(),
    timeZone: rows.timeZone,
    routines,
    // Only unattended routine steps: a live turn's confirm is answered in the Hydra card.
    approvals: rows.approvals.flatMap((a) => {
      const routineId = a.source === "routine" && a.run_id ? runToRoutine.get(a.run_id) : undefined;
      return routineId
        ? [{ id: a.id, routineId, routineName: names.get(routineId) ?? "Routine", runId: a.run_id!, summary: a.summary, reason: a.reason, danger: a.danger, createdAt: a.created_at }]
        : [];
    }),
  };
}
