"use server";

import { ownerSession, ownerToolCtx } from "@/lib/agent/caller";
import { LIVE_GROUPS } from "@/lib/agent/config";
import { supabaseStore } from "@/lib/agent/store";
import { undoAction } from "@/lib/agent/tools";
import { createServerClient } from "@/lib/supabase/server";
import { undoActivitiesWith, undoActivityWith } from "./undo";
import { UNDO_DAYS, type UndoResult } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An agent action logged before its writes were tagged (no activity rows): undone by its tool
 * inverse. The owner pressed Undo, so the inverse runs as approved.
 */
async function undoAgentAction(id: string): Promise<UndoResult> {
  const db = await ownerSession();
  if (!db) return { ok: false, error: "not_found" };
  const store = supabaseStore(db);
  const action = await store.getAction(id);
  if (!action) return { ok: false, error: "not_found" };
  if (action.undone_at) return { ok: false, error: "already_undone" };
  if (Date.now() - new Date(action.created_at).getTime() > UNDO_DAYS * 86_400_000) return { ok: false, error: "expired" };
  const result = await undoAction(id, ownerToolCtx({ db, deviceId: null }, store, { surface: "web", allowed: LIVE_GROUPS }), { approved: true, refuseLogged: true });
  if (result.status === "ok") return { ok: true, undoId: result.actionId ?? id };
  return { ok: false, error: /already undone/i.test("message" in result ? String(result.message) : "") ? "already_undone" : "failed" };
}

/** Undo one past action. `force` undoes it even when the rows changed since. */
export async function undoActivity(id: string, opts: { force?: boolean } = {}): Promise<UndoResult> {
  if (typeof id !== "string" || !UUID.test(id)) return { ok: false, error: "not_found" };
  try {
    const result = await undoActivityWith(await createServerClient(), id, opts);
    return result.ok || result.error !== "not_found" ? result : await undoAgentAction(id);
  } catch (e) {
    console.error(`[activity] undo ${id}: ${(e as Error).message}`);
    return { ok: false, error: "failed" };
  }
}

/**
 * Undo the activities of one page delete made of several calls (three rules, a video's posts), in
 * the order the calls ran: one transaction, all come back or none.
 */
export async function undoActivities(ids: string[], opts: { force?: boolean } = {}): Promise<UndoResult> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((id) => typeof id === "string" && UUID.test(id)))
    return { ok: false, error: "not_found" };
  try {
    return await undoActivitiesWith(await createServerClient(), ids, opts);
  } catch (e) {
    console.error(`[activity] undo ${ids.join(",")}: ${(e as Error).message}`);
    return { ok: false, error: "failed" };
  }
}
