"use client";

import { useMemo, useState } from "react";

import { filterTasks, liveFilters } from "@/lib/planning/tasks";
import { DEFAULT_BOARD_SORT, DEFAULT_FILTERS, DEFAULT_TABLE_SORT, type BoardGroupBy, type PlanningFilters, type PlanningView, type TaskSortSpec } from "@/lib/planning/types";

import { GoalDrawer } from "./goal-drawer";
import { GoalsStrip } from "./goals-strip";
import { PlanningBoard } from "./planning-board";
import { usePlanning } from "./planning-store";
import { PlanningTable } from "./planning-table";
import { PlanningToolbar } from "./planning-toolbar";
import { TaskDrawer } from "./task-drawer";

/**
 * Goals strip, toolbar, the Board or the Table, and the two slide-outs. Mount it inside a
 * PlanningProvider. The Planning page (U14) adds the Calendar view and the page header around it.
 */
export function PlanningWorkspace() {
  const store = usePlanning();
  const { snapshot, error, dismissError } = store;
  const [view, setView] = useState<PlanningView>("board");
  const [groupBy, setGroupBy] = useState<BoardGroupBy>("status");
  const [filters, setFilters] = useState<PlanningFilters>(DEFAULT_FILTERS);
  const [tableSort, setTableSort] = useState<TaskSortSpec>(DEFAULT_TABLE_SORT);

  // A filter whose goal, category or property was deleted falls back, so it never hides everything.
  const live = useMemo(() => liveFilters(filters, snapshot), [filters, snapshot]);
  const tasks = useMemo(() => filterTasks(snapshot.tasks, live, { statuses: snapshot.statuses }), [live, snapshot]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {error ? (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-rule-2 bg-tint px-3 py-2 text-label">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={dismissError} className="text-ink-3 hover:text-ink">
            Dismiss
          </button>
        </div>
      ) : null}
      <GoalsStrip />
      <PlanningToolbar view={view} onView={setView} groupBy={groupBy} onGroupBy={setGroupBy} filters={live} onFilters={setFilters} />
      {view === "board" ? (
        <PlanningBoard tasks={tasks} groupBy={groupBy} sort={DEFAULT_BOARD_SORT} />
      ) : (
        <PlanningTable tasks={tasks} sort={tableSort} onSort={setTableSort} />
      )}
      <TaskDrawer />
      <GoalDrawer />
    </div>
  );
}
