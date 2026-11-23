import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { moveFilesAfterUndo } from "./files";
import { changedLine, type ChangedSince } from "./summary";
import type { UndoResult } from "./types";

type DbUndo =
  | { ok: true; undoId: string; undoIds?: string[] }
  | { ok: false; error: "changed_since"; changed: ChangedSince[]; blocked?: boolean }
  | { ok: false; error: "expired" | "already_undone" | "not_found" };

/** The Planning tables Google Calendar mirrors, and the item kind calendar.ts calls each. */
const MIRRORED = { planning_tasks: "task", events: "event" } as const;

/**
 * A Planning task or event the undo put back, changed or removed: mirror it to Google the way a page
 * write does (DESIGN.md decision 7). A restored item is pushed again, a removed one is taken off the
 * calendar (its link survives the delete: google_calendar_links is not logged).
 */
type Mirrored = { kind: "task" | "event"; id: string; removed: boolean };

async function mirroredBy(db: SupabaseClient, undoId: string): Promise<Mirrored[]> {
  const { data, error } = await db
    .from("activity_rows")
    .select("tbl, op, pk")
    .eq("activity_id", undoId)
    .in("tbl", Object.keys(MIRRORED))
    .order("seq");
  if (error) {
    console.error(`[activity] google after undo ${undoId}: ${error.message}`);
    return [];
  }
  const items = new Map<string, Mirrored>();
  for (const r of (data ?? []) as { tbl: keyof typeof MIRRORED; op: string; pk: { id?: string } }[]) {
    if (!(r.tbl in MIRRORED) || typeof r.pk?.id !== "string") continue;
    // The last row of an item wins: removed only when the undo ends with it gone.
    items.set(`${r.tbl}:${r.pk.id}`, { kind: MIRRORED[r.tbl], id: r.pk.id, removed: r.op === "delete" });
  }
  return [...items.values()];
}

async function mirror(items: Mirrored[]): Promise<void> {
  const { pushToGoogle, removeFromGoogle } = await import("@/lib/google/calendar");
  for (const it of items) {
    const r = await (it.removed ? removeFromGoogle : pushToGoogle)(it.kind, it.id);
    if (!r.ok && r.error.code !== "not_configured") console.error(`[activity] google ${it.kind} ${it.id}: ${r.error.code}`);
  }
}

/** After a successful undo: files back from (or into) the trash now; Google once the response is sent. */
async function afterUndo(db: SupabaseClient, pairs: [original: string, undoId: string][]): Promise<void> {
  const items: Mirrored[] = [];
  for (const [original, undoId] of pairs) {
    await moveFilesAfterUndo(db, original, undoId);
    items.push(...(await mirroredBy(db, undoId)));
  }
  if (!items.length) return;
  try {
    after(() => mirror(items));
  } catch {
    await mirror(items); // outside a request (a script): now
  }
}

function fromDb(r: DbUndo): UndoResult {
  if (r.ok) return { ok: true, undoId: r.undoId };
  if (r.error === "changed_since")
    return { ok: false, error: "changed_since", changed: r.changed.slice(0, 20).map(changedLine), ...(r.blocked ? { blocked: true } : {}) };
  return { ok: false, error: r.error };
}

export async function undoActivityWith(db: SupabaseClient, id: string, opts: { force?: boolean } = {}): Promise<UndoResult> {
  const { data, error } = await db.rpc("undo_activity", { p_id: id, p_force: opts.force === true });
  if (error) {
    console.error(`[activity] undo ${id}: ${error.message}`);
    return { ok: false, error: "failed" };
  }
  const r = data as DbUndo;
  if (r.ok) await afterUndo(db, [[id, r.undoId]]);
  return fromDb(r);
}

/** Several activities of one page delete, undone newest first in one transaction: all or none. */
export async function undoActivitiesWith(db: SupabaseClient, ids: string[], opts: { force?: boolean } = {}): Promise<UndoResult> {
  if (ids.length === 1) return undoActivityWith(db, ids[0], opts);
  const { data, error } = await db.rpc("undo_activities", { p_ids: ids, p_force: opts.force === true });
  if (error) {
    console.error(`[activity] undo ${ids.join(",")}: ${error.message}`);
    return { ok: false, error: "failed" };
  }
  const r = data as DbUndo;
  if (r.ok) {
    // undo_activities undid them newest first: undoIds[i] belongs to ids[ids.length - 1 - i].
    const undoIds = r.undoIds ?? [r.undoId];
    await afterUndo(db, undoIds.map((u, i) => [ids[ids.length - 1 - i], u]));
  }
  return fromDb(r);
}
