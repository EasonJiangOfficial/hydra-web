"use client";

import { useEffect, useState } from "react";

import { readGoal, type GoalReading } from "@/lib/planning/goals";
import type { PlanningGoal } from "@/lib/planning/types";

import { usePlanning } from "./planning-store";

/**
 * A goal's live reading (its metrics through the registry, its task progress). Resolvers can be
 * async, so this settles after the first render; until then the bar shows the task progress.
 */
export function useGoalReading(goal: PlanningGoal): GoalReading | null {
  const { snapshot, today, registry } = usePlanning();
  const [reading, setReading] = useState<GoalReading | null>(null);
  useEffect(() => {
    let live = true;
    void readGoal(goal, { tasks: snapshot.tasks, statuses: snapshot.statuses, today, timeZone: snapshot.timeZone, registry }).then((r) => {
      if (live) setReading(r);
    });
    return () => {
      live = false;
    };
  }, [goal, snapshot.tasks, snapshot.statuses, snapshot.timeZone, today, registry]);
  return reading;
}
