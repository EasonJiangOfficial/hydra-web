"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import { Bar, Card, Input, Label, cn } from "@/components/kit";
import { deadlineLabel } from "@/lib/planning/dates";
import { sortGoals } from "@/lib/planning/goals";
import { METRICS, formatMetric } from "@/lib/planning/metrics";
import type { PlanningGoal } from "@/lib/planning/types";

import { useGoalReading } from "./goal-reading";
import { usePlanning } from "./planning-store";
import { CategoryPill } from "./task-card";

function GoalCard({ goal }: { goal: PlanningGoal }) {
  const { openGoal, today, snapshot } = usePlanning();
  const reading = useGoalReading(goal);
  const first = goal.metrics[0];
  const firstReading = reading?.metrics[0];
  const due = deadlineLabel(goal.deadline, today, goal.achievedAt !== null);
  const percent = reading?.percent ?? 0;
  return (
    <Card as="button" type="button" onClick={() => openGoal(goal.id)} aria-label={`Open goal ${goal.title}`} className="gap-2 p-4 max-sm:w-[78vw] max-sm:shrink-0 max-sm:snap-start" data-goal-id={goal.id}>
      <span className="flex items-center gap-2">
        <span className="flex-1 truncate text-body font-medium">{goal.title}</span>
        {goal.category ? <CategoryPill category={goal.category} colors={snapshot.categoryColors} /> : null}
      </span>
      <span className="flex items-center gap-2 text-tag text-ink-3">
        <span className="flex-1 truncate">{first ? METRICS[first.metric].label : "Linked tasks"}</span>
        <span className="tabular-nums">
          {first && firstReading ? formatMetric(METRICS[first.metric], firstReading.value) : `${reading?.tasks.done ?? 0} of ${reading?.tasks.total ?? 0}`}
        </span>
      </span>
      <Bar value={percent / 100} aria-label={`${goal.title} progress`} />
      <span className="flex items-center gap-2 text-tag text-ink-3">
        <span className="flex-1 tabular-nums">
          {reading?.tasks.done ?? 0} of {reading?.tasks.total ?? 0} {reading?.tasks.total === 1 ? "task" : "tasks"}
        </span>
        <span className={cn(due.tone === "overdue" && "text-neg")}>{due.text}</span>
      </span>
    </Card>
  );
}

/** The goals row above the views: a card per goal, with a live bar. "+ New goal" adds one. */
export function GoalsStrip() {
  const { snapshot, createGoal, openGoal } = usePlanning();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const goals = sortGoals(snapshot.goals);

  async function add() {
    const text = title.trim();
    if (!text) return;
    const id = await createGoal({ title: text });
    setTitle("");
    setAdding(false);
    if (id) openGoal(id);
  }

  return (
    <section aria-label="Goals" className="flex flex-col gap-2">
      <Label>Goals</Label>
      <div className="flex snap-x gap-3 overflow-x-auto pb-1 sm:grid sm:grid-cols-2 sm:overflow-visible lg:grid-cols-4">
        {goals.map((g) => (
          <GoalCard key={g.id} goal={g} />
        ))}
        {adding ? (
          <div className="flex items-center rounded-xl border border-dashed border-rule-2 p-4 max-sm:w-[78vw] max-sm:shrink-0">
            <Input
              autoFocus
              aria-label="New goal title"
              placeholder="Goal title, press Enter"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => !title.trim() && setAdding(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add();
                } else if (e.key === "Escape") setAdding(false);
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex min-h-[116px] items-center justify-center gap-2 rounded-xl max-sm:min-h-0 max-sm:w-36 max-sm:shrink-0 border border-dashed border-rule-2 p-4 text-label text-ink-3 transition-colors duration-200 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            <Plus aria-hidden strokeWidth={1.5} className="size-4" />
            New goal
          </button>
        )}
      </div>
    </section>
  );
}
