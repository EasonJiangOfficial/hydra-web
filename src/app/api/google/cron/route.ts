import { timingSafeEqual } from "node:crypto";
import { pullCalendar, renewWatch } from "@/lib/google/calendar";
import { fail } from "../respond";

/**
 * GET: the daily Google job for Vercel cron (`Authorization: Bearer $CRON_SECRET`). Renews watch
 * channels before they expire, then pulls, which also covers a missed push notification.
 * No CRON_SECRET: fail closed.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return fail(503, "not_configured", "Missing environment variable CRON_SECRET");
  const [got, want] = [Buffer.from(request.headers.get("authorization") ?? ""), Buffer.from(`Bearer ${secret}`)];
  if (got.length !== want.length || !timingSafeEqual(got, want)) return fail(401, "unauthorized", "Bad cron secret");
  const watch = await renewWatch();
  const pull = await pullCalendar();
  const ok = watch.ok && pull.ok;
  return Response.json({ ok, watch, pull }, { status: ok ? 200 : 500 });
}
