"use server";

import type { z } from "zod";

import { setFollowersSchema } from "@/lib/brand/model";
import { saveFollowerCount } from "@/lib/brand/queries";
import { createServerClient } from "@/lib/supabase/server";
import { invalidInput, type ActionResult } from "@/lib/ugc/schemas";
import * as w from "@/lib/ugc/writes";

/** Save today's follower count (owner zone; the server picks the day). A second save that day replaces it. */
export async function setFollowers(input: z.input<typeof setFollowersSchema>): Promise<ActionResult<{ day: string; followers: number }>> {
  const parsed = setFollowersSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  try {
    const db = await createServerClient();
    const { data: owner, error: ownerError } = await db.rpc("is_owner");
    if (ownerError || owner !== true) return w.fail("not_owner", "Only the owner can do this");
    return await saveFollowerCount(db, parsed.data.followers);
  } catch (e) {
    return w.fail("db_error", e instanceof Error ? e.message : "Unexpected error");
  }
}
