import type { SupabaseClient } from "@supabase/supabase-js";
import { UNDO_DAYS } from "./types";

type TrashFile = { bucket: string; path: string };

/** Remove trash files per bucket, 100 at a time. Removing a file that is already gone is not an error. */
async function removeFiles(admin: SupabaseClient, list: TrashFile[]): Promise<{ files: number; failed: number }> {
  const byBucket = new Map<string, string[]>();
  for (const { bucket, path } of list) byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), path]);
  let files = 0;
  let failed = 0;
  for (const [bucket, paths] of byBucket) {
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100);
      const { error } = await admin.storage.from(bucket).remove(chunk);
      if (error) {
        failed += chunk.length;
        console.error(`[activity] prune ${bucket}: ${error.message}`);
      } else files += chunk.length;
    }
  }
  return { files, failed };
}

/**
 * The daily prune (GET /api/cron/bank): activity older than UNDO_DAYS goes with its row images, and
 * the trash files its deletes left are removed. Files first: while one fails to go, the rows that
 * name it stay, so the next run tries again (no file is left behind with nothing pointing at it).
 * Needs the service-role client.
 */
export async function pruneActivity(admin: SupabaseClient): Promise<{ files: number; failed: number; pruned: boolean }> {
  const listed = await admin.rpc("activity_trash", { p_days: UNDO_DAYS });
  if (listed.error) throw new Error(`prune activity: ${listed.error.message}`);
  const first = (listed.data ?? []) as TrashFile[];
  const done = await removeFiles(admin, first);
  if (done.failed) return { ...done, pruned: false };

  const { data, error } = await admin.rpc("prune_activity", { p_days: UNDO_DAYS });
  if (error) throw new Error(`prune activity: ${error.message}`);
  // Rows that turned 30 days old between the two calls: their files go now (best effort, logged).
  const seen = new Set(first.map((f) => `${f.bucket}/${f.path}`));
  const late = await removeFiles(admin, ((data ?? []) as TrashFile[]).filter((f) => !seen.has(`${f.bucket}/${f.path}`)));
  return { files: done.files + late.files, failed: late.failed, pruned: true };
}
