import "server-only";
import { pushEnv } from "@/lib/push/env";
import { sendPush } from "@/lib/push/send";
import type { Channels, Delivered } from "./deliver";

/** Push services cap a payload near 4 KB; a routine's output can be longer, so the phone gets the start. */
const PUSH_BODY_CHARS = 600;

/** Web push to the owner's phones: throws on a failed send, so deliver() records it as failed. */
export async function pushChannel(n: Delivered): Promise<void> {
  const body = n.body.length > PUSH_BODY_CHARS ? `${n.body.slice(0, PUSH_BODY_CHARS - 1)}…` : n.body;
  const r = await sendPush({ title: n.title.slice(0, 200), body: body || undefined, url: n.href ?? "/", tag: n.id });
  if (!r.ok) throw new Error(`push ${r.code}: ${r.message}`);
}

/**
 * The delivery channels wired today, for the cron's reminders and routine results. Push only when
 * the VAPID env is set; otherwise it is left out and deliver() records it as not_configured.
 * ponytail: email (Gmail via U15) is not wired; it needs an approval id per send.
 */
export function liveChannels(): Channels {
  try {
    pushEnv();
  } catch {
    return {};
  }
  return { push: pushChannel };
}
