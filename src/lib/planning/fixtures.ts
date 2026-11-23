import { DEFAULT_TIME_ZONE, addDays, todayIn, zonedInstant } from "./dates";
import type { PlanningProperty } from "./properties";
import type { PlanningEvent, PlanningGoal, PlanningSnapshot, PlanningStatus, PlanningTask } from "./types";

/**
 * Fixture Planning data for /dev/planning and the tests. Dates are relative to `now`, so the board
 * always shows a believable week. Ids are fixed (valid v4 uuids), so tests can name them.
 */
export const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const FX = {
  statusTodo: id(1),
  statusDoing: id(2),
  statusBlocked: id(3),
  statusDone: id(4),
  goalPosts: id(10),
  goalTax: id(11),
  goalSave: id(12),
  propPriority: id(20),
  optUrgent: id(21),
  optHigh: id(22),
  optMedium: id(23),
  optLow: id(24),
  propEffort: id(25),
} as const;

export function fixtureSnapshot(now: Date = new Date(), timeZone: string = DEFAULT_TIME_ZONE): PlanningSnapshot {
  const today = todayIn(now, timeZone);
  const day = (n: number): string => addDays(today, n);
  const at = (n: number, time: string): string => zonedInstant(day(n), time, timeZone).toISOString();
  const stamp = now.toISOString();

  const statuses: PlanningStatus[] = [
    { id: FX.statusTodo, label: "Not started", color: "#c7c7cc", position: 0, isDone: false },
    { id: FX.statusDoing, label: "In progress", color: "#1d1d1f", position: 1, isDone: false },
    { id: FX.statusBlocked, label: "Blocked", color: "#6e6e73", position: 2, isDone: false },
    { id: FX.statusDone, label: "Done", color: "#8e8e93", position: 3, isDone: true },
  ];

  const properties: PlanningProperty[] = [
    {
      id: FX.propPriority,
      name: "Priority",
      type: "select",
      numberFormat: "number",
      position: 0,
      showOnBoard: true,
      showInList: true,
      options: [
        { id: FX.optUrgent, label: "Urgent", color: "#1d1d1f", position: 0 },
        { id: FX.optHigh, label: "High", color: "#424245", position: 1 },
        { id: FX.optMedium, label: "Medium", color: "#6e6e73", position: 2 },
        { id: FX.optLow, label: "Low", color: "#a1a1a6", position: 3 },
      ],
    },
    {
      id: FX.propEffort,
      name: "Effort",
      type: "number",
      numberFormat: "number",
      position: 1,
      showOnBoard: false,
      showInList: true,
      options: [],
    },
  ];

  const base = { notes: "", createdAt: stamp, updatedAt: stamp, completedAt: null, alertAt: null, repeatRule: null, repeatSeriesId: null, values: {} } as const;
  const priority = (optionId: string) => ({ [FX.propPriority]: { type: "select" as const, optionId } });

  const tasks: PlanningTask[] = [
    { ...base, id: id(100), title: "Film 6 Wordwise videos", statusId: FX.statusTodo, goalId: FX.goalPosts, category: "UGC", dueDate: day(1), position: 1024, values: priority(FX.optHigh) },
    { ...base, id: id(101), title: "Send W-9 to Brightleaf", statusId: FX.statusTodo, goalId: null, category: "Taxes", dueDate: day(3), position: 2048, alertAt: at(3, "09:00"), values: priority(FX.optMedium) },
    { ...base, id: id(102), title: "Set aside Q4 estimated tax", statusId: FX.statusDoing, goalId: FX.goalTax, category: "Taxes", dueDate: day(54), position: 1024, values: priority(FX.optHigh) },
    { ...base, id: id(103), title: "Edit batch 12", statusId: FX.statusDoing, goalId: FX.goalPosts, category: "UGC", dueDate: day(0), position: 2048, repeatRule: "weekly", repeatSeriesId: id(103), values: { ...priority(FX.optUrgent), [FX.propEffort]: { type: "number" as const, value: 3 } } },
    { ...base, id: id(104), title: "Waiting on Plaid Sandbox keys", statusId: FX.statusBlocked, goalId: null, category: "Hydra", dueDate: null, position: 1024, values: priority(FX.optLow) },
    { ...base, id: id(105), title: "Reconcile October", statusId: FX.statusDone, goalId: FX.goalSave, category: "Money", dueDate: day(-2), position: 1024, completedAt: stamp },
    { ...base, id: id(106), title: "Post 3 videos", statusId: FX.statusDone, goalId: FX.goalPosts, category: "UGC", dueDate: day(-1), position: 2048, completedAt: stamp },
    { ...base, id: id(107), title: "Call the accountant", statusId: FX.statusTodo, goalId: FX.goalTax, category: "Taxes", dueDate: day(-1), position: 3072, values: priority(FX.optUrgent) },
  ];

  const goals: PlanningGoal[] = [
    {
      id: FX.goalPosts,
      title: "Post 3 a day",
      notes: "",
      category: "UGC",
      startDate: day(-20),
      deadline: day(40),
      position: 1024,
      achievedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
      metrics: [
        { id: id(200), goalId: FX.goalPosts, metric: "posts_per_day", target: 3, param: null, position: 1024 },
        { id: id(201), goalId: FX.goalPosts, metric: "task_progress", target: 100, param: null, position: 2048 },
      ],
      links: [{ id: id(300), goalId: FX.goalPosts, url: "https://www.tiktok.com/", title: "TikTok", position: 1024 }],
    },
    {
      id: FX.goalTax,
      title: "Taxes ready by January",
      notes: "",
      category: "Taxes",
      startDate: null,
      deadline: day(54),
      position: 2048,
      achievedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
      metrics: [{ id: id(202), goalId: FX.goalTax, metric: "task_progress", target: 100, param: null, position: 1024 }],
      links: [],
    },
    {
      id: FX.goalSave,
      title: "Save 30 percent",
      notes: "",
      category: "Money",
      startDate: null,
      deadline: null,
      position: 3072,
      achievedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
      metrics: [{ id: id(203), goalId: FX.goalSave, metric: "savings_rate", target: 30, param: null, position: 1024 }],
      links: [],
    },
  ];

  const events: PlanningEvent[] = [
    {
      id: id(400),
      title: "Weekly review",
      startsAt: at(2, "10:00"),
      endsAt: at(2, "10:30"),
      allDay: false,
      category: "Hydra",
      repeat: "weekly",
      notes: "",
      alertAt: at(2, "09:50"),
      googleEventId: null,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  return { statuses, tasks, goals, events, properties, timeZone };
}
