import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServerClient } from "@/lib/supabase/server";

import { PlanningError } from "./result";
import { loadTimeZone } from "./repository";

export interface PlanningCtx {
  /** Acts as the signed-in owner: RLS applies on top of the check below. */
  readonly db: SupabaseClient;
  readonly now: () => Date;
  /** The owner's time zone, read once per call. */
  readonly timeZone: () => Promise<string>;
}

/**
 * The context every Planning action runs in. Owner checked first (`is_owner()`): anyone else, or a
 * missing session, is refused before any write is built. The agent's server tools go through the
 * same actions, so they pass the same gate.
 */
export async function ownerCtx(): Promise<PlanningCtx> {
  const db = await createServerClient();
  const { data, error } = await db.rpc("is_owner");
  if (error || data !== true) throw new PlanningError("Not allowed.");
  let zone: Promise<string> | undefined;
  return { db, now: () => new Date(), timeZone: () => (zone ??= loadTimeZone(db)) };
}
