"use client";

import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { GoalDrawer } from "@/components/planning/goal-drawer";
import { GoalsStrip } from "@/components/planning/goals-strip";
import { PlanningBoard } from "@/components/planning/planning-board";
import { PlanningProvider, usePlanning } from "@/components/planning/planning-store";
import { PlanningTable } from "@/components/planning/planning-table";
import { TaskDrawer } from "@/components/planning/task-drawer";
import { defaultMetricRegistry, type MetricRegistry } from "@/lib/planning/metrics";
import { filterTasks, liveFilters } from "@/lib/planning/tasks";
import {
  DEFAULT_BOARD_SORT,
  DEFAULT_FILTERS,
  DEFAULT_TABLE_SORT,
  type BoardGroupBy,
  type PlanningActions,
  type PlanningFilters,
  type PlanningSnapshot,
  type TaskSortSpec,
} from "@/lib/planning/types";
import type { FinanceFacts } from "@/lib/planning-metrics/finance-dates";

import { CalendarView } from "./calendar";
import { filterEvents } from "./calendar-model";
import { DayDrawer } from "./day-drawer";
import { PlanningExtrasProvider, usePlanningExtras } from "./extras";
import { GoogleDeletes, type GoogleDeletesProps } from "./google-deletes";
import { PAGE_VIEWS, PageToolbar, type PageView } from "./page-toolbar";

/** `?view=` keeps the view across a reload and a shared link. */
const viewFrom = (value: string | null): PageView => PAGE_VIEWS.find((v) => v === value) ?? "board";

function Body({ googleDeletes }: { googleDeletes?: GoogleDeletesProps }) {
  const { snapshot, error, dismissError } = usePlanning();
  const extras = usePlanningExtras();
  const search = useSearchParams();
  const [view, setView] = useState<PageView>(() => viewFrom(search.get("view")));
  const [groupBy, setGroupBy] = useState<BoardGroupBy>("status");
  const [filters, setFilters] = useState<PlanningFilters>(DEFAULT_FILTERS);
  const [tableSort, setTableSort] = useState<TaskSortSpec>(DEFAULT_TABLE_SORT);

  // A filter whose goal, category or property was deleted falls back, so it never hides everything.
  const live = useMemo(() => liveFilters(filters, snapshot), [filters, snapshot]);
  const tasks = useMemo(() => filterTasks(snapshot.tasks, live, { statuses: snapshot.statuses }), [live, snapshot]);
  const events = useMemo(() => filterEvents(extras.events, live), [extras.events, live]);

  function pickView(next: PageView): void {
    setView(next);
    // The URL follows, so a reload (and the drawers' own links) keep it. No history entry.
    const url = new URL(window.location.href);
    if (next === "board") url.searchParams.delete("view");
    else url.searchParams.set("view", next);
    window.history.replaceState(window.history.state, "", url);
  }

  const failure = error ?? extras.error;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {failure ? (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-rule-2 bg-tint px-3 py-2 text-label">
          <span className="flex-1">{failure}</span>
          <button type="button" onClick={error ? dismissError : extras.dismissError} className="text-ink-3 hover:text-ink">
            Dismiss
          </button>
        </div>
      ) : null}
      {googleDeletes ? <GoogleDeletes {...googleDeletes} /> : null}
      <GoalsStrip />
      <PageToolbar view={view} onView={pickView} groupBy={groupBy} onGroupBy={setGroupBy} filters={live} onFilters={setFilters} />
      {view === "board" ? (
        <PlanningBoard tasks={tasks} groupBy={groupBy} sort={DEFAULT_BOARD_SORT} />
      ) : view === "calendar" ? (
        <CalendarView tasks={tasks} events={events} />
      ) : (
        <PlanningTable tasks={tasks} sort={tableSort} onSort={setTableSort} />
      )}
      <TaskDrawer />
      <GoalDrawer />
      <DayDrawer />
    </div>
  );
}

/**
 * The Planning page: goals strip with live metric bars, Board / Calendar / Table, filters by
 * category and goal, New, and the task, goal and day panels. The live page and /dev/planning-page
 * both mount this; only the actions, the finance facts and the metric registry differ. Mount it
 * inside a Suspense boundary (the drawers read the URL).
 */
export function PlanningPage({
  initial,
  actions,
  facts,
  registry = defaultMetricRegistry,
  now,
  googleDeletes,
}: {
  initial: PlanningSnapshot;
  actions: PlanningActions;
  facts: FinanceFacts;
  registry?: MetricRegistry;
  /** ISO instant. Freezes the clock (the fixture). */
  now?: string;
  /** Items deleted in Google Calendar, waiting for the owner's Delete or Keep. */
  googleDeletes?: GoogleDeletesProps;
}) {
  return (
    <PlanningProvider initial={initial} actions={actions} now={now} registry={registry}>
      <PlanningExtrasProvider initialEvents={initial.events} facts={facts} actions={actions}>
        <Body googleDeletes={googleDeletes} />
      </PlanningExtrasProvider>
    </PlanningProvider>
  );
}
