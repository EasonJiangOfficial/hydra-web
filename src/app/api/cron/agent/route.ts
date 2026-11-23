import { timingSafeEqual } from "node:crypto";
import { fetchAsOwner } from "@/lib/agent/bridge";
import { liveChannels } from "@/lib/agent/channels";
import { runCron } from "@/lib/agent/cron";
import { supabaseRelay } from "@/lib/agent/relay";
import { supabaseStore } from "@/lib/agent/store";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/cron/agent (Vercel cron, every minute, `Authorization: Bearer $CRON_SECRET`): claims due
 * routines and reminders once per occurrence, delivers reminders, and starts each claimed routine
 * run as the owner (POST /api/agent/routines/run through the owner-session bridge).
 */
export const maxDuration = 300;

function authorized(request: Request, secret: string): boolean {
  const want = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(request.headers.get("authorization") ?? "");
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: "not_configured" }, { status: 503 });
  if (!authorized(request, secret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const runUrl = new URL("/api/agent/routines/run", request.url);
  const result = await runCron({
    store: supabaseStore(admin),
    db: admin,
    now: new Date(),
    channels: liveChannels(),
    relay: supabaseRelay(admin),
    runRoutine: async (runId) => {
      const res = await fetchAsOwner(runUrl, {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify({ runId }),
      });
      if (!res.ok && res.status !== 409) throw new Error(`routine run ${runId}: ${res.status}`);
    },
  });
  return Response.json({ ok: true, ...result });
}
