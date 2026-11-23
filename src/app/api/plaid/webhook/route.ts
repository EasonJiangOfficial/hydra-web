import { after } from "next/server";
import { createPlaidProvider } from "@/lib/bank/plaid";
import { WebhookVerifyError, type WebhookEvent } from "@/lib/bank/provider";
import { runSync } from "@/lib/bank/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Plaid webhooks. Public (Plaid has no session): trust comes only from the signed JWT, checked per
 * Plaid's steps before the body is read as data. A sync event marks the item (`sync_requested_at`,
 * so the daily cron picks it up if this run dies) and syncs after the response. An item event
 * updates the item's status (login needed, expiring, revoked, repaired).
 */
export async function POST(request: Request) {
  const raw = await request.text();
  let event: WebhookEvent;
  try {
    event = await createPlaidProvider().verifyWebhook(raw, request.headers);
  } catch (error) {
    if (error instanceof WebhookVerifyError) return Response.json({ ok: false }, { status: 401 });
    console.error(`[plaid/webhook] ${(error as Error).message}`);
    return Response.json({ ok: false }, { status: 503 });
  }
  if (event.kind === "ignored") return Response.json({ ok: true });

  const patch =
    event.kind === "sync"
      ? { sync_requested_at: new Date().toISOString() }
      : { status: event.status, last_error: event.errorCode };
  const { data, error } = await createAdminClient()
    .from("bank_items")
    .update(patch)
    .eq("provider", "plaid")
    .eq("provider_item_id", event.providerItemId)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error(`[plaid/webhook] ${error.message}`);
    return Response.json({ ok: false }, { status: 500 });
  }
  if (data && event.kind === "sync") {
    const itemId = data.id as string;
    after(() =>
      runSync(itemId).then(
        (r) => r.status === "error" && console.error(`[plaid/webhook] sync ${itemId}: ${r.code}`),
        (e) => console.error(`[plaid/webhook] sync ${itemId}: ${(e as Error).message}`),
      ),
    );
  }
  return Response.json({ ok: true });
}
