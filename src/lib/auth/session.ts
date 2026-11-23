"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { markUnlocked } from "./idle";

function localStore() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Runs after any successful sign-in or unlock. The database decides who the owner is
 * (`is_owner()`); anyone else is signed straight back out. First login stores the browser's
 * time zone (DESIGN.md section 3).
 */
export async function finishSignIn(supabase: SupabaseClient): Promise<"ok" | "not-owner"> {
  const { data: owner, error } = await supabase.rpc("is_owner");
  if (error || owner !== true) {
    await supabase.auth.signOut({ scope: "local" });
    return "not-owner";
  }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (timeZone) await supabase.from("settings").update({ time_zone: timeZone }).is("time_zone", null);
  const store = localStore();
  if (store) markUnlocked(store, Date.now());
  return "ok";
}
