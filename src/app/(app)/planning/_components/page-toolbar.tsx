"use client";

import { Plus } from "lucide-react";

import { Button, Input, Seg } from "@/components/kit";
import { Checkbox } from "@/components/ui/checkbox";
import { ColorDot } from "@/components/ui/color-picker";
import { Select } from "@/components/ui/select";
import { usePlanning } from "@/components/planning/planning-store";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { pillColors } from "@/lib/label-colors";
import { categoriesOf, categoryColorOf } from "@/lib/planning/tasks";
import type { BoardGroupBy, PlanningFilters } from "@/lib/planning/types";

import { useOpenDay } from "./day-drawer";
import { usePlanningExtras } from "./extras";

export type PageView = "board" | "calendar" | "table";
export const PAGE_VIEWS: readonly PageView[] = ["board", "calendar", "table"];

export interface PageToolbarProps {
  view: PageView;
  onView: (view: PageView) => void;
  groupBy: BoardGroupBy;
  onGroupBy: (groupBy: BoardGroupBy) => void;
  filters: PlanningFilters;
  onFilters: (filters: PlanningFilters) => void;
}

/** "+ New": a task, an event or a goal, each made with a placeholder title and opened to edit. */
function NewMenu() {
  const store = usePlanning();
  const extras = usePlanningExtras();
  const openDay = useOpenDay();
  const firstOpen = [...store.snapshot.statuses].sort((a, b) => a.position - b.position).find((s) => !s.isDone);

  async function newTask(): Promise<void> {
    if (!firstOpen) return;
    const id = await store.createTask({ title: "New task", statusId: firstOpen.id });
    if (id) store.openTask(id);
  }
  async function newEvent(): Promise<void> {
    const id = await extras.createEvent({ title: "New event", date: store.today });
    if (id) openDay(store.today, id);
  }
  async function newGoal(): Promise<void> {
    const id = await store.createGoal({ title: "New goal" });
    if (id) store.openGoal(id);
  }

  const item = "cursor-pointer rounded-md px-3 py-2 text-body focus:bg-tint focus:text-ink";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="primary" aria-label="New">
          <Plus aria-hidden strokeWidth={1.5} />
          New
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40 bg-surface">
        <DropdownMenuItem className={item} onSelect={() => void newTask()}>
          Task
        </DropdownMenuItem>
        <DropdownMenuItem className={item} onSelect={() => void newEvent()}>
          Event
        </DropdownMenuItem>
        <DropdownMenuItem className={item} onSelect={() => void newGoal()}>
          Goal
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** View switch, group (Board), category and goal filters, search and New. */
export function PageToolbar({ view, onView, groupBy, onGroupBy, filters, onFilters }: PageToolbarProps) {
  const { snapshot } = usePlanning();
  const { events } = usePlanningExtras();
  const categories = categoriesOf({ tasks: snapshot.tasks, goals: snapshot.goals, events });
  const selects = snapshot.properties.filter((p) => p.type === "select");
  const filterColor = filters.category === "all" || filters.category === "none" ? undefined : (categoryColorOf(snapshot, filters.category) ?? undefined);
  return (
    <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Planning controls">
      <Seg
        aria-label="View"
        value={view}
        onValueChange={(v) => onView(v as PageView)}
        items={[
          { value: "board", label: "Board" },
          { value: "calendar", label: "Calendar" },
          { value: "table", label: "Table" },
        ]}
      />
      {view === "board" ? (
        <Select aria-label="Group by" value={groupBy} onChange={(e) => onGroupBy(e.target.value)}>
          <option value="status">Group: Status</option>
          <option value="category">Group: Category</option>
          <option value="goal">Group: Goal</option>
          {selects.map((p) => (
            <option key={p.id} value={`prop:${p.id}`}>
              Group: {p.name}
            </option>
          ))}
        </Select>
      ) : null}
      <Select
        aria-label="Category filter"
        className="max-sm:w-[calc(50%-4px)]"
        value={filters.category}
        onChange={(e) => onFilters({ ...filters, category: e.target.value })}
        // A colored category, once picked, tints the filter like its pill; each option shows its color dot.
        data-color={filterColor}
        style={filterColor ? pillColors(filterColor) : undefined}
        options={[
          { value: "all", label: "Category: All", icon: <ColorDot reserve color={null} /> },
          { value: "none", label: "No category", icon: <ColorDot reserve color={null} /> },
          ...categories.map((c) => ({ value: c, label: c, icon: <ColorDot reserve color={categoryColorOf(snapshot, c)} /> })),
        ]}
      />
      <Select aria-label="Goal filter" className="max-sm:w-[calc(50%-4px)]" value={filters.goal} onChange={(e) => onFilters({ ...filters, goal: e.target.value })}>
        <option value="all">Goal: All</option>
        <option value="none">No goal</option>
        {snapshot.goals.map((g) => (
          <option key={g.id} value={g.id}>
            {g.title}
          </option>
        ))}
      </Select>
      <label className="flex h-[34px] cursor-pointer items-center gap-2 px-1 text-label text-ink-2">
        <Checkbox checked={filters.hideDone} onChange={(e) => onFilters({ ...filters, hideDone: e.target.checked })} />
        Hide done
      </label>
      <div className="flex-1 max-sm:hidden" />
      <Input
        type="search"
        aria-label="Search tasks"
        placeholder="Search"
        className="w-40 max-sm:min-w-0 max-sm:flex-1"
        value={filters.search}
        onChange={(e) => onFilters({ ...filters, search: e.target.value })}
      />
      <NewMenu />
    </div>
  );
}
