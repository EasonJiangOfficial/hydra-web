import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Files a delete removes (tax documents, deal logos) are kept 30 days: moved to
 * `trash/<activity id>/<path>` in their own bucket, put back on undo, removed by the daily prune
 * (public.prune_activity names them).
 */

/** The bucket and path column of each table whose rows own a Storage file. */
export const FILE_TABLES: Record<string, { bucket: string; column: string }> = {
  tax_documents: { bucket: "tax-docs", column: "storage_path" },
  deals: { bucket: "deal-logos", column: "logo_path" },
};

export const trashPath = (activityId: string, path: string) => `trash/${activityId}/${path}`;

/** Move a file to the trash of this activity. Returns false (and logs) when it could not. */
export async function trashFile(db: SupabaseClient, bucket: string, path: string, activityId: string | null): Promise<boolean> {
  const { error } = activityId
    ? await db.storage.from(bucket).move(path, trashPath(activityId, path))
    : await db.storage.from(bucket).remove([path]); // no activity to undo it from: plain delete, as before
  if (error) console.error(`[activity] file ${bucket}/${path}: ${error.message}`);
  return !error;
}

/** A logo another deal or a template still points at stays put (Ripple imports can share one). Unsure = in use. */
export async function logoInUse(db: SupabaseClient, path: string): Promise<boolean> {
  const [deals, templates] = await Promise.all([
    db.from("deals").select("id").eq("logo_path", path).limit(1),
    db.from("deal_templates").select("id").eq("logo_path", path).limit(1),
  ]);
  return Boolean(deals.error || templates.error || deals.data?.length || templates.data?.length);
}

type UndoRow = { tbl: string; op: "insert" | "update" | "delete"; old: Record<string, unknown> | null; new: Record<string, unknown> | null };

/**
 * After undo `undoId` of activity `originalId`: a row the undo put back gets its file back from the
 * original's trash; a row the undo deleted again (a redo) sends its file to the undo's trash.
 */
export async function moveFilesAfterUndo(db: SupabaseClient, originalId: string, undoId: string): Promise<void> {
  const { data, error } = await db
    .from("activity_rows")
    .select("tbl, op, old, new")
    .eq("activity_id", undoId)
    .in("tbl", Object.keys(FILE_TABLES))
    .in("op", ["insert", "delete"]);
  if (error) {
    console.error(`[activity] files after undo ${undoId}: ${error.message}`);
    return;
  }
  for (const r of (data ?? []) as UndoRow[]) {
    const { bucket, column } = FILE_TABLES[r.tbl];
    const path = (r.op === "insert" ? r.new : r.old)?.[column];
    if (typeof path !== "string" || !path) continue;
    if (r.op === "delete" && r.tbl === "deals" && (await logoInUse(db, path))) continue;
    const { error: moved } =
      r.op === "insert"
        ? await db.storage.from(bucket).move(trashPath(originalId, path), path)
        : await db.storage.from(bucket).move(path, trashPath(undoId, path));
    // A file that was never trashed (a logo another row shares) stays where it is: nothing to do.
    if (moved) console.error(`[activity] file ${bucket}/${path}: ${moved.message}`);
  }
}
