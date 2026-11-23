"use client";

import { defaultAnimateLayoutChanges, useSortable, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowRight, Bell, Repeat } from "lucide-react";
import { forwardRef, useState, type RefObject } from "react";

import { Button, Pill, cn } from "@/components/kit";
import { ColorPill } from "@/components/ui/color-picker";
import { dueTone, formatDay } from "@/lib/planning/dates";
import { formatPropertyValue } from "@/lib/planning/properties";
import { REPEAT_LABELS } from "@/lib/planning/repeat";
import { categoryColorOf, isDoneTask } from "@/lib/planning/tasks";
import type { PlanningTask } from "@/lib/planning/types";

import { usePlanning } from "./planning-store";

/** A category as a pill: tinted in the category's color, plain text when it has none. */
export function CategoryPill({ category, colors }: { category: string; colors?: Readonly<Record<string, string>> }) {
  const color = categoryColorOf({ categoryColors: colors }, category);
  return color ? <ColorPill color={color}>{category}</ColorPill> : <Pill>{category}</Pill>;
}

/** The card's visible content, shared by the live card and the drag preview. */
export function TaskCardBody({ task }: { task: PlanningTask }) {
  const { snapshot, today } = usePlanning();
  const goal = task.goalId ? snapshot.goals.find((g) => g.id === task.goalId) : undefined;
  const done = isDoneTask(task, snapshot.statuses);
  const tone = done ? null : dueTone(task.dueDate, today);
  const props = snapshot.properties.flatMap((p) => {
    const v = task.values[p.id];
    return p.showOnBoard && v && v.type !== "select" && v.type !== "multi_select" ? [formatPropertyValue(p, v, today)].filter(Boolean) : [];
  });
  // Select values show as tag pills in their option's color.
  const tags = snapshot.properties.flatMap((p) => {
    const v = task.values[p.id];
    if (!p.showOnBoard || !v || (v.type !== "select" && v.type !== "multi_select")) return [];
    const ids: readonly string[] = v.type === "select" ? [v.optionId] : v.optionIds;
    return p.options.filter((o) => ids.includes(o.id));
  });
  return (
    <>
      <span className={cn("text-body font-medium break-words", done && "text-ink-3")}>{task.title}</span>
      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-tag text-ink-3">
        {task.category ? <CategoryPill category={task.category} colors={snapshot.categoryColors} /> : null}
        {goal ? <span className="max-w-full truncate">{goal.title}</span> : null}
        {task.dueDate ? (
          <span className={cn("tabular-nums", tone === "overdue" && "text-neg")}>
            {tone === "overdue" ? "Overdue " : ""}
            {formatDay(task.dueDate, today)}
          </span>
        ) : null}
        {task.repeatRule ? (
          <span className="inline-flex items-center" title={`Repeats ${REPEAT_LABELS[task.repeatRule].toLowerCase()}`}>
            <Repeat aria-hidden strokeWidth={1.5} className="size-3.5" />
            <span className="sr-only">Repeats {REPEAT_LABELS[task.repeatRule].toLowerCase()}</span>
          </span>
        ) : null}
        {task.alertAt ? (
          <span className="inline-flex items-center" title="Has an alert">
            <Bell aria-hidden strokeWidth={1.5} className="size-3.5" />
            <span className="sr-only">Has an alert</span>
          </span>
        ) : null}
      </span>
      {tags.length > 0 ? (
        <span className="flex flex-wrap gap-1">
          {tags.map((o) => (
            <ColorPill key={o.id} color={o.color}>
              {o.label}
            </ColorPill>
          ))}
        </span>
      ) : null}
      {props.length > 0 ? <span className="text-tag text-ink-2">{props.join(" · ")}</span> : null}
    </>
  );
}

/**
 * Pointer-transparent copy of a card that follows the cursor while dragging. It fills the
 * overlay box (the card's size) and lifts in: up 2%, tilted 1 degree, an ink hairline, no shadow.
 * Reduced motion: no lift.
 */
export const TaskCardPreview = forwardRef<HTMLDivElement, { task: PlanningTask }>(function TaskCardPreview({ task }, ref) {
  const { snapshot } = usePlanning();
  const index = snapshot.statuses.findIndex((s) => s.id === task.statusId);
  const next = index >= 0 ? snapshot.statuses[index + 1] : undefined;
  return (
    <div
      ref={ref}
      aria-hidden
      data-task-preview={task.id}
      className="pointer-events-none flex h-full cursor-grabbing flex-col rounded-lg border border-ink bg-surface transition-[scale,rotate] duration-150 ease-hydra motion-safe:scale-[1.02] motion-safe:rotate-1 motion-safe:starting:scale-100 motion-safe:starting:rotate-0"
    >
      {/* The same boxes as TaskCard below, so the real card takes over at the drop without a shift. */}
      <div className="flex flex-col gap-2 p-3 pb-2">
        <TaskCardBody task={task} />
      </div>
      {/* The card's Move row, drawn still, so the lifted copy is the card itself. */}
      {next ? (
        <div className="mt-auto flex justify-end px-2 pb-2">
          <span data-move-row className="inline-flex h-7 items-center justify-center gap-1 rounded-lg border border-transparent px-2 text-tag font-medium text-ink-3">
            Move
            <ArrowRight aria-hidden strokeWidth={1.5} className="size-3.5" />
          </span>
        </div>
      ) : null}
    </div>
  );
});

/** Sibling cards slide while a card is held; after a drop settle() moves them instead. */
const slideWhileHeld: AnimateLayoutChanges = (args) => (args.isSorting ? defaultAnimateLayoutChanges(args) : false);

export function TaskCard({ task, justDragged }: { task: PlanningTask; justDragged: RefObject<boolean> }) {
  const { openTask, moveTask, snapshot } = usePlanning();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    animateLayoutChanges: slideWhileHeld,
  });
  // Touch: the card presses in while the finger holds, before it lifts (the hold is 220 ms).
  const [pressing, setPressing] = useState(false);
  const release = () => setPressing(false);
  // Pointer and touch start a drag from the whole card; only the handle takes the keyboard.
  const { onKeyDown, ...pointerListeners } = listeners ?? {};
  const index = snapshot.statuses.findIndex((s) => s.id === task.statusId);
  const next = index >= 0 ? snapshot.statuses[index + 1] : undefined;

  return (
    <div
      ref={setNodeRef}
      data-task-id={task.id}
      {...pointerListeners}
      onPointerDown={(e) => e.pointerType === "touch" && setPressing(true)}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
      data-dragging={isDragging || undefined}
      style={{
        transform: CSS.Transform.toString(transform),
        // No background fade: a dropped card is white the moment it starts to settle.
        transition: [transition, "scale 200ms ease", "border-color 200ms ease"].filter(Boolean).join(", "),
      }}
      className={cn(
        "group relative touch-manipulation rounded-lg border border-rule bg-surface select-none [-webkit-touch-callout:none]",
        // The slot the held card leaves (or will land in): a quiet tint, no content, no shadow.
        isDragging ? "border-dashed border-rule-2 bg-hover *:opacity-0" : "hover:border-rule-2",
        pressing && !isDragging && "motion-safe:scale-[0.98]",
      )}
    >
      <button
        ref={setActivatorNodeRef}
        data-drag-handle
        type="button"
        {...attributes}
        onKeyDown={(event) => onKeyDown?.(event)}
        aria-label={`Reorder ${task.title}`}
        // Keyboard only: hidden until focused (pointers drag the whole card).
        className="pointer-events-none absolute top-2 right-2 z-10 rounded-md border border-rule-2 bg-surface px-2 py-1 text-tag opacity-0 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ink"
      >
        Reorder
      </button>
      <button
        type="button"
        onClick={() => {
          if (!justDragged.current && !isDragging) openTask(task.id);
        }}
        aria-label={`Open ${task.title}`}
        className="flex w-full flex-col gap-2 rounded-lg p-3 pb-2 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <TaskCardBody task={task} />
      </button>
      {next ? (
        <div className="flex justify-end px-2 pb-2">
          <Button
            data-move-row
            variant="ghost"
            className="h-7 gap-1 px-2 text-tag text-ink-3"
            aria-label={`Move ${task.title} to ${next.label}`}
            onClick={() => void moveTask(task.id, { statusId: next.id })}
          >
            Move
            <ArrowRight aria-hidden strokeWidth={1.5} className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
