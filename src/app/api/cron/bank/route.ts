import { timingSafeEqual } from "node:crypto";
import { pruneActivity } from "@/lib/activity/prune";
import { listSweepItems, runBankCron } from "@/lib/bank/cron";
import { ownerTimeZone, runSync } from "@/lib/bank/server";
import { dayIn } from "@/lib/bank/sync";
import { detectAndSaveRecurring, processIngested } from "@/lib/rules/engine";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/cron/bank (Vercel cron, daily, `Authorization: Bearer $CRON_SECRET`): syncs every live bank
 * item (webhook-flagged ones first), then runs rules, transfer pairing and recurring detection.
 * See src/lib/bank/cron.ts. First, the daily Activity prune (30 days, src/lib/activity/prune.ts).
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
  const now = new Date();
  // Activity past 30 days goes (with its trash files) first: a bank sweep that throws or runs out of
  // time never skips it, and a failed prune never fails the bank sweep.
  const activity = await pruneActivity(admin).catch((e: Error) => {
    console.error(`[cron/bank] ${e.message}`);
    return { error: "prune_failed" };
  });
  const result = await runBankCron({
    listItems: () => listSweepItems(admin),
    sync: runSync,
    processIngested: (since) => processIngested(admin, since),
    detectRecurring: async () => detectAndSaveRecurring(admin, dayIn(await ownerTimeZone(admin), now)),
    now,
  });
  return Response.json({ ok: true, ...result, activity });
}
