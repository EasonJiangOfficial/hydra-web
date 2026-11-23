import "server-only";

import type { AccountsData, BankItemView, ConnectorKeyView, DeviceView, EntityView } from "@/components/accounts/types";
import { plaidEnv, tokenKey } from "@/lib/bank/env";
import { googleEnv } from "@/lib/google/client";
import { loadInstagramView } from "@/lib/instagram/oauth";
import { listAccounts } from "@/lib/bank/queries";
import { ownerToday } from "@/lib/bank/server";
import { listRecurring } from "@/lib/rules/queries";
import { createServerClient } from "@/lib/supabase/server";

/** True when the Plaid keys and the token key are set, so Link can start. Never throws. */
function plaidConfigured(): boolean {
  try {
    plaidEnv();
    tokenKey();
    return true;
  } catch {
    return false;
  }
}

/** True when the Google OAuth client and the token key are set, so Connect Google can start. Never throws. */
function googleConfigured(): boolean {
  try {
    googleEnv();
    tokenKey();
    return true;
  } catch {
    return false;
  }
}

function must<T>(what: string, result: { data: T | null; error: { message: string } | null }): T {
  if (result.error || result.data === null) throw new Error(`${what}: ${result.error?.message ?? "no data"}`);
  return result.data;
}

/** A connector read that failed shows as not connected (logged) instead of failing the whole page. */
function soft<T>(what: string, result: { data: T | null; error: { message: string } | null }): T | null {
  if (result.error) console.error(`[accounts] ${what}: ${result.error.message}`);
  return result.error ? null : result.data;
}

/** Everything the Accounts page shows, read as the signed-in owner (RLS keeps it to the owner). Call after a dynamic read. */
export async function loadAccountsData(): Promise<AccountsData> {
  const db = await createServerClient();
  const [today, accounts, items, recurring, entities, settings, google, instagram, keys, devices, push] = await Promise.all([
    ownerToday(db),
    listAccounts(db),
    db.from("bank_items").select("id, institution_name, status, last_synced_at, last_error").order("created_at"),
    listRecurring(db),
    db.from("entities").select("id, name, slug, status").order("created_at"),
    db.from("settings").select("idle_lock_minutes").maybeSingle(),
    db.from("google_accounts").select("email, status").maybeSingle(),
    loadInstagramView(db),
    db.from("api_keys").select("id, name, prefix, created_at, last_used_at").is("revoked_at", null).order("created_at", { ascending: false }),
    db.from("agent_devices").select("id, name, last_seen_at, created_at, scopes, role, relay_seen_at").is("revoked_at", null).order("created_at", { ascending: false }),
    db.from("push_subscriptions").select("id", { count: "exact", head: true }),
  ]);
  if (settings.error) throw new Error(`settings: ${settings.error.message}`);
  const bankItems = must("bank items", items) as unknown as BankItemView[];
  return {
    now: new Date().toISOString(),
    today,
    accounts,
    items: bankItems,
    recurring,
    entities: (must("entities", entities) as unknown as (Omit<EntityView, "closed"> & { status: string })[]).map(({ status, ...e }) => ({
      ...e,
      closed: status === "closed",
    })),
    idleLockMinutes: (settings.data?.idle_lock_minutes as number | null | undefined) ?? null,
    plaidConfigured: plaidConfigured(),
    // ponytail: revoked logins count too (the Trial's ten are for life); revoked rows stay in bank_items.
    plaidLoginsUsed: bankItems.length,
    google: {
      configured: googleConfigured(),
      email: (soft("google account", google) as { email?: string } | null)?.email ?? null,
      status: (google.data as { status?: string } | null)?.status ?? null,
    },
    instagram,
    apiKeys: (soft("connector keys", keys) ?? []) as ConnectorKeyView[],
    devices: (soft("devices", devices) ?? []) as DeviceView[],
    pushDevices: soft("push subscriptions", { data: push.count, error: push.error }) ?? 0,
  };
}
