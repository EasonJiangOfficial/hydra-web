"use client";

import { Input, Seg } from "@/components/kit";
import { pillColors } from "@/lib/label-colors";
import { categoriesOf, categoryColorOf } from "@/lib/planning/tasks";
import type { BoardGroupBy, PlanningFilters, PlanningView } from "@/lib/planning/types";

import { Checkbox } from "@/components/ui/checkbox";
import { ColorDot } from "@/components/ui/color-picker";
import { Select } from "@/components/ui/select";
import { usePlanning } from "./planning-store";

export interface ToolbarProps {
  view: PlanningView;
  onView: (view: PlanningView) => void;
  groupBy: BoardGroupBy;
  onGroupBy: (groupBy: BoardGroupBy) => void;
  filters: PlanningFilters;
  onFilters: (filters: PlanningFilters) => void;
}

/** View, group, filters and search. Group applies to the Board only. */
export function PlanningToolbar({ view, onView, groupBy, onGroupBy, filters, onFilters }: ToolbarProps) {
  const { snapshot } = usePlanning();
  const categories = categoriesOf(snapshot);
  const selects = snapshot.properties.filter((p) => p.type === "select");
  const filterColor = filters.category === "all" || filters.category === "none" ? undefined : (categoryColorOf(snapshot, filters.category) ?? undefined);
  return (
    <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Planning controls">
      <Seg
        aria-label="View"
        value={view}
        onValueChange={(v) => onView(v as PlanningView)}
        items={[
          { value: "board", label: "Board" },
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
    </div>
  );
}
