import { after } from "next/server";
import { pullCalendar, verifyNotification } from "@/lib/google/calendar";

/**
 * Google Calendar push notifications for the Hydra calendar. Public (Google has no session): trust
 * comes only from the channel id, resource id and secret token Hydra registered. No body to read.
 * A change pulls after the response; the first "sync" message only confirms the channel.
 * 5xx makes Google retry, so only a failure on our side answers 503.
 */
export async function POST(request: Request) {
  let check: Awaited<ReturnType<typeof verifyNotification>>;
  try {
    check = await verifyNotification(request.headers);
  } catch (error) {
    console.error(`[google/webhook] ${(error as Error).message}`);
    return Response.json({ ok: false }, { status: 503 });
  }
  if (!check.ok) return Response.json({ ok: false }, { status: 401 });
  if (check.state !== "sync") {
    after(() =>
      pullCalendar().then(
        (r) => !r.ok && console.error(`[google/webhook] pull: ${r.error.code}`),
        (e) => console.error(`[google/webhook] pull: ${(e as Error).message}`),
      ),
    );
  }
  return Response.json({ ok: true });
}
