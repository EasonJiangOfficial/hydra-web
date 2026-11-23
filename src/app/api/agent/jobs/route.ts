import { z } from "zod";
import { asOwner, json, readJson } from "@/lib/agent/caller";
import { CAPABILITIES_HEADER, capabilitiesSchema } from "@/lib/agent/relay-schema";
import { supabaseStore } from "@/lib/agent/store";

/**
 * Hydra Desktop's pull: GET claims its queued Mac steps and the notifications it has not shown
 * (reminders and routine results, spoken when asked). POST {jobId, status, result} reports a step.
 * Device key (scope "agent") only: the bridge labels the call with the device id. A risky step approve all let
 * through (needs_tags, 0200) goes only to a pull that itself declares approveAllDeletionTags (CAPABILITIES_HEADER):
 * this request's build, not a record from an earlier poll, so an older or downgraded Mac never gets it.
 */
const resultSchema = z.object({ jobId: z.uuid(), status: z.enum(["done", "failed"]), result: z.unknown().optional() });

export async function GET(request: Request) {
  return asOwner(request, "agent", async (caller) => {
    if (!caller.deviceId) return json({ error: "device_only" }, 400);
    const store = supabaseStore(caller.db);
    const tags = capabilitiesSchema.parse(request.headers.get(CAPABILITIES_HEADER)).approveAllDeletionTags === 1;
    const [jobs, notifications] = await Promise.all([store.claimDesktopJobs(caller.deviceId, 10, tags), store.pullDesktopNotifications(20)]);
    return json({ jobs, notifications });
  });
}

export async function POST(request: Request) {
  return asOwner(request, "agent", async (caller) => {
    if (!caller.deviceId) return json({ error: "device_only" }, 400);
    const body = resultSchema.safeParse(await readJson(request));
    if (!body.success) return json({ error: "invalid_input" }, 400);
    const store = supabaseStore(caller.db);
    const job = await store.finishDesktopJob(body.data.jobId, body.data.status, body.data.result ?? null);
    if (!job) return json({ error: "not_claimed" }, 409);
    if (job.run_id) {
      const run = await store.getRun(job.run_id);
      if (run?.status === "waiting_mac") await store.updateRun(job.run_id, { status: body.data.status === "done" ? "ok" : "failed" });
    }
    return json({ ok: true });
  });
}
