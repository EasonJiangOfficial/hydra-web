import { createServerClient } from "@/lib/supabase/server";
import { listActivityWith } from "./list";
import type { ActivityPage } from "./types";

/** Newest first; `before` is the `next` cursor of the previous page. */
export async function listActivity(opts: { before?: string; limit?: number } = {}): Promise<ActivityPage> {
  return listActivityWith(await createServerClient(), opts);
}
