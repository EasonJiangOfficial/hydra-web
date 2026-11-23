import "server-only";

import { ownerSession } from "@/lib/agent/caller";
import { supabaseStore } from "@/lib/agent/store";
import { buildRoutinesData } from "@/components/routines/build";
import type { RoutinesData } from "@/components/routines/types";

/** Everything the Routines page shows, read as the signed-in owner. Null when the caller is not the owner. Call after a dynamic read. */
export async function loadRoutinesData(): Promise<RoutinesData | null> {
  const db = await ownerSession();
  if (!db) return null;
  const store = supabaseStore(db);
  const [routines, runs, actions, approvals, timeZone] = await Promise.all([
    store.listRoutines(),
    store.recentRuns(null, 200),
    store.recentActions(300),
    store.pendingApprovals(),
    store.timeZone(),
  ]);
  return buildRoutinesData({ now: new Date(), timeZone, routines, runs, actions, approvals });
}
