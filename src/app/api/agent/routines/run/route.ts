import { z } from "zod";
import { json, ownerSession, readJson } from "@/lib/agent/caller";
import { liveChannels } from "@/lib/agent/channels";
import { createModelClient } from "@/lib/agent/config";
import { runRoutineJob } from "@/lib/agent/cron";
import { supabaseRelay } from "@/lib/agent/relay";
import { supabaseStore } from "@/lib/agent/store";

/**
 * POST /api/agent/routines/run {runId}: run one claimed routine occurrence as the owner. The cron
 * calls it through the owner-session bridge; a run starts once (queued -> running compare-and-set).
 * When the Mac is the brain the run becomes a relay turn for Hydra Desktop (or waits, or is skipped).
 */
export const maxDuration = 300;

const bodySchema = z.object({ runId: z.uuid() });

export async function POST(request: Request) {
  const db = await ownerSession();
  if (!db) return json({ error: "unauthorized" }, 401);
  const body = bodySchema.safeParse(await readJson(request));
  if (!body.success) return json({ error: "invalid_input" }, 400);
  const status = await runRoutineJob(body.data.runId, {
    client: createModelClient(),
    store: supabaseStore(db),
    db,
    now: () => new Date(),
    channels: liveChannels(),
    relay: supabaseRelay(db),
  });
  return status ? json({ ok: true, status }) : json({ error: "not_queued" }, 409);
}
