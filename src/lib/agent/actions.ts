"use server";

import { activityIdOf } from "@/lib/activity/request";

import { ownerSession, ownerToolCtx } from "./caller";
import { LIVE_GROUPS } from "./config";
import { describeSchedule, type Schedule } from "./schedule";
import { supabaseStore, type RoutineRow, type RunRow } from "./store";
import { executeTool, type ExecResult } from "./tools";

/**
 * Typed actions for the Routines page (U19) and any other page: the same tools the agent uses, so
 * every change lands in the activity list with undo. The page asks before a delete (its own plain
 * confirm), so the call is made as approved.
 */

const ROUTINE_ACTIONS = ["create_routine", "update_routine", "pause_routine", "resume_routine", "run_routine_now", "delete_routine"] as const;
export type RoutineAction = (typeof ROUTINE_ACTIONS)[number];

export async function routineAction(tool: RoutineAction, input: Record<string, unknown>): Promise<ExecResult & { activityId?: string | null }> {
  // A server action takes any string from the browser: only the routine tools pass.
  if (!(ROUTINE_ACTIONS as readonly string[]).includes(tool)) return { status: "error", message: "Unknown routine action" };
  const db = await ownerSession();
  if (!db) return { status: "error", message: "Sign in as the owner" };
  const store = supabaseStore(db);
  const r = await executeTool(tool, input, ownerToolCtx({ db, deviceId: null }, store, { surface: "web", allowed: LIVE_GROUPS }), { approved: true });
  // A delete returns its activity, so the page can offer Undo.
  return tool === "delete_routine" && r.status === "ok" ? { ...r, activityId: activityIdOf(db) } : r;
}

export async function listRoutinesWithRuns(): Promise<(RoutineRow & { scheduleText: string; runs: RunRow[] })[] | null> {
  const db = await ownerSession();
  if (!db) return null;
  const store = supabaseStore(db);
  const [routines, runs] = await Promise.all([store.listRoutines(), store.recentRuns(null, 200)]);
  return routines.map((r) => ({
    ...r,
    scheduleText: describeSchedule(r.schedule as Schedule),
    runs: runs.filter((run) => run.routine_id === r.id).slice(0, 20),
  }));
}
