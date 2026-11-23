import type { SupabaseClient } from "@supabase/supabase-js";
import type { SyncResult } from "./sync";

/**
 * The daily bank sweep (DESIGN 5: "Vercel cron, daily: bank sync, recurring detection").
 * 1. Sync every live item, items a webhook flagged (`sync_requested_at`: its sync died or lost a race)
 *    first, oldest flag first. Two sweeps at once are safe: each page write takes the item's advisory
 *    lock and compares the cursor, so one sync wins and the other stops with 'conflict'.
 * 2. Rules and transfer pairing over every row written in the last day and a half, which catches pages
 *    whose own run died before its rules ran. Idempotent.
 * 3. Recurring detection.
 * One item failing never stops the others.
 */

export interface BankCronDeps {
  listItems(): Promise<{ id: string }[]>;
  sync(itemId: string): Promise<SyncResult>;
  processIngested(since: Date): Promise<{ checked: number; changed: number; paired: number }>;
  detectRecurring(): Promise<{ found: number; saved: number }>;
  now: Date;
}

const SWEEP_LOOKBACK_MS = 36 * 3_600_000;

export async function runBankCron(deps: BankCronDeps) {
  const items: ({ itemId: string } & (SyncResult | { status: "failed"; message: string }))[] = [];
  for (const { id } of await deps.listItems()) {
    try {
      items.push({ itemId: id, ...(await deps.sync(id)) });
    } catch (error) {
      items.push({ itemId: id, status: "failed", message: (error as Error).message });
    }
  }
  const rules = await deps.processIngested(new Date(deps.now.getTime() - SWEEP_LOOKBACK_MS));
  const recurring = await deps.detectRecurring();
  return { items, rules, recurring };
}

/** Live items (not revoked, not waiting on the owner's login), flagged ones first, oldest flag first. */
export async function listSweepItems(db: SupabaseClient): Promise<{ id: string }[]> {
  const { data, error } = await db
    .from("bank_items")
    .select("id")
    .in("status", ["active", "pending_expiration", "error"])
    .order("sync_requested_at", { ascending: true, nullsFirst: false })
    .order("created_at");
  if (error) throw new Error(`list bank items: ${error.message}`);
  return (data ?? []) as { id: string }[];
}
