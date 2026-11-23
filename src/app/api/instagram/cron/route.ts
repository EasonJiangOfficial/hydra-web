import { timingSafeEqual } from "node:crypto";
import { run } from "@/lib/instagram/client";
import { syncInstagram } from "@/lib/instagram/sync";
import { fail } from "../../google/respond";

/**
 * GET: the daily Instagram sync for Vercel cron (`Authorization: Bearer $CRON_SECRET`). Not connected, or
 * waiting on a Reconnect: nothing to do (200). No CRON_SECRET: fail closed.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return fail(503, "not_configured", "Missing environment variable CRON_SECRET");
  const [got, want] = [Buffer.from(request.headers.get("authorization") ?? ""), Buffer.from(`Bearer ${secret}`)];
  if (got.length !== want.length || !timingSafeEqual(got, want)) return fail(401, "unauthorized", "Bad cron secret");
  const sync = await run(() => syncInstagram());
  const idle = !sync.ok && ["not_connected", "reauth_required", "busy"].includes(sync.error.code);
  return Response.json({ ok: sync.ok || idle, sync }, { status: sync.ok || idle ? 200 : 500 });
}
