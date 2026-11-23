import { sendNotification, setVapidDetails } from "web-push";
import { createAdminClient } from "@/lib/supabase/admin";
import { MissingEnvError } from "@/lib/supabase/env";
import { pushEnv } from "./env";

/**
 * Send a web push to every subscription the owner has (one owner, so no recipient argument).
 * Server jobs only (the reminder cron, routines, the agent): it reads with the service role.
 * Fails closed: no VAPID env, or a bad key or subject, sends nothing and says why.
 * A subscription the push service reports gone (404 or 410) is deleted.
 */

export interface PushPayload {
  title: string;
  body?: string;
  /** Where a tap goes: a path on this site, like "/planning". Defaults to the Dashboard. */
  url?: string;
  /** A second push with the same tag replaces the first on the phone. */
  tag?: string;
}

export type PushResult =
  | { ok: true; sent: number; pruned: number; failed: number }
  | { ok: false; code: "not_configured" | "invalid_input" | "internal"; message: string };

const MAX_BYTES = 3500; // push services cap a payload near 4 KB
const TTL_SECONDS = 60 * 60 * 24; // a reminder an hour late is useful; one a week late is not

export async function sendPush(payload: PushPayload): Promise<PushResult> {
  if (!payload.title.trim()) return { ok: false, code: "invalid_input", message: "A push needs a title" };
  if (payload.url !== undefined && !/^\/(?![/\\])/.test(payload.url)) {
    return { ok: false, code: "invalid_input", message: "The push url must be a path on this site" };
  }
  const body = JSON.stringify({ title: payload.title, body: payload.body, url: payload.url, tag: payload.tag });
  if (Buffer.byteLength(body) > MAX_BYTES) return { ok: false, code: "invalid_input", message: "The push is too long" };

  try {
    const { publicKey, privateKey, subject } = pushEnv();
    setVapidDetails(subject, publicKey, privateKey); // throws on a bad subject or key
  } catch (error) {
    const message = error instanceof MissingEnvError ? error.message : `Invalid VAPID settings: ${(error as Error).message}`;
    return { ok: false, code: "not_configured", message };
  }

  try {
    const db = createAdminClient();
    const { data, error } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth");
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { id: string; endpoint: string; p256dh: string; auth: string }[];

    const outcomes = await Promise.allSettled(
      rows.map((row) =>
        sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, body, { TTL: TTL_SECONDS }),
      ),
    );
    const gone: string[] = [];
    let sent = 0;
    let failed = 0;
    outcomes.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") return void sent++;
      const status = (outcome.reason as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) gone.push(rows[i].id);
      else {
        failed++;
        console.error(`[push] send failed (${status ?? (outcome.reason as Error).message})`); // never log the endpoint or keys
      }
    });
    if (gone.length) {
      const { error: deleteError } = await db.from("push_subscriptions").delete().in("id", gone);
      if (deleteError) console.error(`[push] prune failed: ${deleteError.message}`);
    }
    return { ok: true, sent, pruned: gone.length, failed };
  } catch (error) {
    if (error instanceof MissingEnvError) return { ok: false, code: "not_configured", message: error.message };
    console.error(`[push] ${(error as Error).message}`);
    return { ok: false, code: "internal", message: "Something went wrong" };
  }
}
