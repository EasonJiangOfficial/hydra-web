import "server-only";

import type { SettingsData } from "@/components/settings/types";
import { entityUse, listEntities } from "@/lib/entities/queries";
import { createServerClient } from "@/lib/supabase/server";

import { loadAccountsData } from "../accounts/data";

/** Everything the Settings page shows, read as the signed-in owner. Call after a dynamic read. */
export async function loadSettingsData(): Promise<SettingsData> {
  const db = await createServerClient();
  const [entities, use, settings, accounts] = await Promise.all([
    listEntities(db),
    entityUse(db),
    db.from("settings").select("time_zone").maybeSingle(),
    loadAccountsData(),
  ]);
  if (settings.error) throw new Error(`settings: ${settings.error.message}`);
  return {
    businesses: entities.map((e) => ({ ...e, inUse: use[e.id]?.inUse ?? true, accounts: use[e.id]?.accounts ?? 0 })),
    timeZone: (settings.data?.time_zone as string | null | undefined) ?? null,
    accounts,
  };
}
