import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { detectAndSaveRecurring, processIngested } from "@/lib/rules/engine";
import { createPlaidProvider } from "./plaid";
import { afterEachPage, dayIn, supabaseSyncStore, syncItem, type SyncResult } from "./sync";

/** Server-side bank helpers. Not actions: nothing here checks the caller, so never export it from a "use server" file. */

export class NotOwnerError extends Error {
  constructor() {
    super("Not the owner");
    this.name = "NotOwnerError";
  }
}

/** The signed-in owner's client (RLS applies) and user id. The database decides who the owner is. */
export async function requireOwner(): Promise<{ db: SupabaseClient; userId: string }> {
  const db = await createServerClient();
  const [{ data: owner, error }, { data: claims }] = await Promise.all([db.rpc("is_owner"), db.auth.getClaims()]);
  const userId = claims?.claims?.sub;
  if (error || owner !== true || typeof userId !== "string") throw new NotOwnerError();
  return { db, userId };
}

/** The owner's time zone setting (null until first login writes it: then UTC). */
export async function ownerTimeZone(db: SupabaseClient): Promise<string> {
  const { data } = await db.from("settings").select("time_zone").maybeSingle();
  return (data?.time_zone as string | null) || "UTC";
}

export async function ownerToday(db: SupabaseClient, now = new Date()): Promise<string> {
  return dayIn(await ownerTimeZone(db), now);
}

const logFail = (what: string) => (error: unknown) => console.error(`[bank] ${what}: ${(error as Error).message}`);

/**
 * Sync one bank item as the server: the owner's "sync now", the webhook, the daily cron. After each
 * page lands, rules and transfer pairing run over its rows (DESIGN 9: "apply on ingest"); after a sync
 * that wrote anything, recurring detection runs. Those steps only log on failure: the rows are already
 * in, and the daily cron (/api/cron/bank) runs them again.
 */
export async function runSync(itemId: string): Promise<SyncResult> {
  const admin = createAdminClient();
  const timeZone = await ownerTimeZone(admin);
  const store = afterEachPage(supabaseSyncStore(admin), ({ startedAt }) =>
    processIngested(admin, startedAt).then(() => undefined, logFail(`rules after sync ${itemId}`)),
  );
  const result = await syncItem(itemId, { store, provider: createPlaidProvider(), timeZone });
  if (result.pages > 0) await detectAndSaveRecurring(admin, dayIn(timeZone, new Date())).catch(logFail(`recurring after sync ${itemId}`));
  return result;
}

/** Where Plaid sends webhooks for links made from this host. None for localhost (Plaid cannot reach it). */
export async function webhookUrl(): Promise<string | undefined> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host || /^(localhost|127\.|\[::1\])/.test(host)) return undefined;
  return `${h.get("x-forwarded-proto") ?? "https"}://${host}/api/plaid/webhook`;
}
