import type { Schedule } from "@/lib/agent/schedule";
import type { Delivery, GateReason, RoutineTool, RunStatus } from "@/lib/agent/store";

export type { Delivery, GateReason, RoutineTool, RunStatus, Schedule };

/** One thing a run did, from the activity list. Undoable until undone. */
export interface ActionView {
  id: string;
  summary: string;
  undoable: boolean;
  undone: boolean;
}

export interface RunView {
  id: string;
  occurrenceAt: string;
  status: RunStatus;
  output: string;
  error: string | null;
  actions: ActionView[];
}

export interface RoutineView {
  id: string;
  name: string;
  instruction: string;
  schedule: Schedule;
  scheduleText: string;
  tools: RoutineTool[];
  delivery: Delivery[];
  whenMacOff: "wait" | "skip";
  paused: boolean;
  nextRunAt: string | null;
  /** Newest first. */
  runs: RunView[];
}

/** An unattended step that waits for the owner. */
export interface ApprovalView {
  id: string;
  routineId: string;
  routineName: string;
  runId: string;
  summary: string;
  reason: GateReason;
  danger: boolean;
  createdAt: string;
}

export interface RoutinesData {
  /** ISO instant the data was read; "today" and "tomorrow" are counted from it. */
  now: string;
  /** The owner's time zone: every time on the page is shown in it. */
  timeZone: string;
  routines: RoutineView[];
  approvals: ApprovalView[];
}

/** What the form edits and the create and update actions take. */
export interface RoutineInput {
  name: string;
  instruction: string;
  schedule: Schedule;
  tools: RoutineTool[];
  delivery: Delivery[];
  whenMacOff: "wait" | "skip";
}

export type Result = { ok: true; id?: string; message?: string; activityId?: string | null } | { ok: false; message: string };

/** Everything the page can do. The live page backs these with the agent's routine actions and routes; /dev/routines with memory. */
export interface RoutinesActions {
  create(input: RoutineInput): Promise<Result>;
  update(id: string, input: RoutineInput): Promise<Result>;
  setPaused(id: string, paused: boolean): Promise<Result>;
  runNow(id: string): Promise<Result>;
  /** The page asks first; this deletes. */
  remove(id: string): Promise<Result>;
  decide(approvalId: string, approve: boolean): Promise<Result>;
  undo(actionId: string): Promise<Result>;
}
