import { timingSafeEqual } from "node:crypto";
import { pushToGoogle } from "@/lib/google/calendar";
import { loadTimeZone } from "@/lib/planning/repository";
import { extendRepeatSeries } from "@/lib/planning/repeats";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/cron/planning (Vercel cron, `Authorization: Bearer $CRON_SECRET`): makes the next copy
 * of every repeating task (and so every repeating task reminder) in the owner's time zone, then
 * puts each new copy on the Hydra Google calendar when Google is connected. Safe to run twice: a
 * copy is keyed on (series, period).
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
  const run = await extendRepeatSeries(admin, new Date(), await loadTimeZone(admin));
  let pushed = 0;
  for (const id of run.ids) {
    const res = await pushToGoogle("task", id);
    if (res.ok && res.data === "created") pushed++;
  }
  // Every made copy is pushed first; a failed series then answers 500 so the cron run shows red.
  const failed = run.failed.length;
  return Response.json(
    { ok: failed === 0, series: run.series, created: run.created, pushed, failed },
    { status: failed ? 500 : 200 },
  );
}
