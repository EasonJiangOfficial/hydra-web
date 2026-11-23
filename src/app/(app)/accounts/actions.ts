"use server";

import { z } from "zod";

import type { ActionResult } from "@/lib/bank/actions";
import { balanceHistory, type BalanceRow } from "@/lib/bank/queries";
import { NotOwnerError, requireOwner } from "@/lib/bank/server";
import { canonicalTimeZone } from "@/lib/planning/dates";

/**
 * The Accounts-page writes and reads that U2 and U3 do not cover. Same contract as the other typed actions:
 * owner checked first, input validated, expected failures come back as `{ ok: false, error }`.
 */

const fail = <T>(code: string, message: string): ActionResult<T> => ({ ok: false, error: { code, message } });

async function asOwner<T>(run: (owner: Awaited<ReturnType<typeof requireOwner>>) => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await run(await requireOwner()) };
  } catch (error) {
    if (error instanceof NotOwnerError) return fail("not_owner", "Sign in as the owner");
    console.error(`[accounts] ${(error as Error).message}`);
    return fail("internal", "Something went wrong");
  }
}

/** settings.idle_lock_minutes: 1 to 60 turns the idle lock on, null turns it off (the default). */
export async function setIdleLock(input: { minutes: number | null }): Promise<ActionResult<{ minutes: number | null }>> {
  const parsed = z.object({ minutes: z.int().min(1).max(60).nullable() }).safeParse(input);
  if (!parsed.success) return fail("invalid_input", "Pick 1 to 60 minutes, or turn it off");
  return asOwner(async ({ db, userId }) => {
    const { error } = await db.from("settings").upsert({ user_id: userId, idle_lock_minutes: parsed.data.minutes }, { onConflict: "user_id" });
    if (error) throw new Error(`set idle lock: ${error.message}`);
    return { minutes: parsed.data.minutes };
  });
}

/**
 * settings.time_zone: the IANA zone every "today", due date and reminder is read in, stored by its
 * IANA name. null clears it (the next sign-in fills it from the browser). An offset or an
 * abbreviation is refused: Postgres would read "+05:00" as five hours west.
 */
export async function setTimeZone(input: { timeZone: string | null }): Promise<ActionResult<{ timeZone: string | null }>> {
  const parsed = z.object({ timeZone: z.string().min(1).max(100).nullable() }).safeParse(input);
  const zone = parsed.success && parsed.data.timeZone !== null ? canonicalTimeZone(parsed.data.timeZone) : null;
  if (!parsed.success || (parsed.data.timeZone !== null && !zone)) return fail("invalid_input", "Not a time zone (use a name like America/Toronto)");
  return asOwner(async ({ db, userId }) => {
    const { error } = await db.from("settings").upsert({ user_id: userId, time_zone: zone }, { onConflict: "user_id" });
    if (error) throw new Error(`set time zone: ${error.message}`);
    return { timeZone: zone };
  });
}

/** One account's daily balances, oldest first, for the history chart. */
export async function loadBalanceHistory(input: { accountId: string }): Promise<ActionResult<BalanceRow[]>> {
  const parsed = z.object({ accountId: z.guid() }).safeParse(input);
  if (!parsed.success) return fail("invalid_input", "Not an account id");
  return asOwner(({ db }) => balanceHistory(db, { accountId: parsed.data.accountId }));
}
