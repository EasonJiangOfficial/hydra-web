"use client";

import { ArrowDown, ArrowUp, Bell, Repeat } from "lucide-react";

import { Card, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@/components/kit";
import { ColorDot } from "@/components/ui/color-picker";
import { DatePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";
import { pillColors } from "@/lib/label-colors";
import { dueTone } from "@/lib/planning/dates";
import { categoryColorOf, isDoneTask, sortTasks } from "@/lib/planning/tasks";
import { DEFAULT_TABLE_SORT, type PlanningTask, type TaskSortKey, type TaskSortSpec } from "@/lib/planning/types";

import { usePlanning } from "./planning-store";
import { PropertyValueEditor } from "./property-value-editor";

/** A cell control reads as plain text until it is hovered or focused. */
const CELL_SELECT = "h-8 min-w-32 border-transparent bg-transparent hover:border-rule-2 focus:border-ink";
const CELL_INPUT = "h-8 border-transparent bg-transparent px-2 hover:border-rule-2 focus:border-ink";

function SortHead({ label, sortKey, sort, onSort, className }: { label: string; sortKey: TaskSortKey; sort: TaskSortSpec; onSort: (key: TaskSortKey) => void; className?: string }) {
  const on = sort.key === sortKey;
  return (
    <TableHead aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-label text-ink-3 outline-none transition-colors duration-200 hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
      >
        {label}
        {on ? sort.dir === "asc" ? <ArrowUp aria-hidden strokeWidth={1.5} className="size-3.5" /> : <ArrowDown aria-hidden strokeWidth={1.5} className="size-3.5" /> : null}
      </button>
    </TableHead>
  );
}

function Row({ task }: { task: PlanningTask }) {
  const { snapshot, today, openTask, updateTask, moveTask } = usePlanning();
  const done = isDoneTask(task, snapshot.statuses);
  const tone = done ? null : dueTone(task.dueDate, today);
  const categoryColor = categoryColorOf(snapshot, task.category) ?? undefined;
  return (
    <TableRow data-task-id={task.id}>
      <TableCell className="max-w-72 min-w-48">
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => openTask(task.id)}
            aria-label={`Open ${task.title}`}
            className={cn("min-w-0 truncate rounded-md px-1 py-0.5 text-left text-body font-medium outline-none hover:underline focus-visible:outline-2 focus-visible:outline-ink", done && "text-ink-3")}
          >
            {task.title}
          </button>
          {task.repeatRule ? <Repeat aria-label="Repeats" strokeWidth={1.5} className="size-3.5 shrink-0 text-ink-3" /> : null}
          {task.alertAt ? <Bell aria-label="Has an alert" strokeWidth={1.5} className="size-3.5 shrink-0 text-ink-3" /> : null}
        </span>
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-0.5">
          <ColorDot reserve color={snapshot.statuses.find((s) => s.id === task.statusId)?.color} />
          <Select
            aria-label={`Status of ${task.title}`}
            // 10 px under the other cells' minimum: the dot and its gap take the rest, so the table still fits at 1440.
            className={cn(CELL_SELECT, "min-w-[118px]")}
            value={task.statusId}
            onChange={(e) => void moveTask(task.id, { statusId: e.target.value })}
            options={snapshot.statuses.map((s) => ({ value: s.id, label: s.label, icon: <ColorDot reserve color={s.color} /> }))}
          />
        </span>
      </TableCell>
      <TableCell>
        <Input
          key={task.category ?? ""}
          aria-label={`Category of ${task.title}`}
          defaultValue={task.category ?? ""}
          placeholder="None"
          maxLength={60}
          // A colored category reads as its tinted pill, still editable in place.
          data-color={categoryColor}
          style={categoryColor ? pillColors(categoryColor) : undefined}
          className={cn(CELL_INPUT, "w-32", categoryColor && "font-medium")}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          onBlur={(e) => {
            const next = e.target.value.trim() || null;
            if (next !== task.category) void updateTask(task.id, { category: next });
          }}
        />
      </TableCell>
      <TableCell>
        <Select
          aria-label={`Goal of ${task.title}`}
          className={cn(CELL_SELECT, "w-48")}
          value={task.goalId ?? ""}
          onChange={(e) => void updateTask(task.id, { goalId: e.target.value || null })}
        >
          <option value="">No goal</option>
          {snapshot.goals.map((g) => (
            <option key={g.id} value={g.id}>
              {g.title}
            </option>
          ))}
        </Select>
      </TableCell>
      <TableCell>
        <DatePicker
          aria-label={`Due date of ${task.title}`}
          timeZone={snapshot.timeZone}
          value={task.dueDate ?? ""}
          className={cn(CELL_INPUT, "w-40 px-0 [&_input]:pl-2", tone === "overdue" && "[&_input]:text-neg")}
          onChange={(e) => void updateTask(task.id, { dueDate: e.target.value || null })}
        />
      </TableCell>
      {snapshot.properties
        .filter((p) => p.showInList)
        .map((p) => (
          <TableCell key={p.id} className="min-w-28">
            <PropertyValueEditor task={task} property={p} compact />
          </TableCell>
        ))}
    </TableRow>
  );
}

/**
 * The Table: one row per task. Click a header to sort (again to reverse), click any cell to edit
 * it in place, click a title to open the task. Properties with "show in table" get a column.
 * Tight column gaps (the cell controls carry their own padding) so the seeded columns fit at 1440
 * with the sidebar open; a phone, or many extra properties, scrolls sideways.
 */
export function PlanningTable({ tasks, sort, onSort }: { tasks: readonly PlanningTask[]; sort: TaskSortSpec; onSort: (sort: TaskSortSpec) => void }) {
  const { snapshot } = usePlanning();
  const rows = sortTasks(tasks, sort, snapshot.statuses, { properties: snapshot.properties });
  const pick = (key: TaskSortKey) =>
    onSort(sort.key === key ? (sort.dir === "asc" ? { key, dir: "desc" } : DEFAULT_TABLE_SORT) : { key, dir: "asc" });
  const head = { sort, onSort: pick };
  return (
    <Card className="min-h-0 flex-1 gap-0 overflow-x-auto p-0 max-md:p-0">
      <Table data-testid="table" className="[&_td]:px-1.5 [&_th]:px-1.5 [&_tr>*:first-child]:pl-3 [&_tr>*:last-child]:pr-3">
        <TableHeader>
          <TableRow>
            <SortHead label="Title" sortKey="title" {...head} />
            <SortHead label="Status" sortKey="status" {...head} />
            <SortHead label="Category" sortKey="category" {...head} />
            <TableHead className="text-label font-normal text-ink-3">Goal</TableHead>
            <SortHead label="Due" sortKey="due" {...head} />
            {snapshot.properties
              .filter((p) => p.showInList)
              .map((p) => (
                <SortHead key={p.id} label={p.name} sortKey={`prop:${p.id}`} {...head} />
              ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((t) => (
            <Row key={t.id} task={t} />
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
