import { after } from "next/server";
import { pullCalendar, pushAll, startWatch } from "@/lib/google/calendar";
import { run } from "@/lib/google/client";
import { checkState, finishSignIn, OAUTH_COOKIE } from "@/lib/google/oauth";
import { oauthCookie, ownerOnly, readCookie, webhookAddress } from "../respond";

/**
 * GET: Google sends the owner back here. The state must match the cookie set by /start before any
 * code is exchanged. Then: store the tokens encrypted, make the "Hydra" calendar, watch it, and
 * (after the response) put the Planning items on it and take the first pull.
 */
export async function GET(request: Request) {
  const denied = await ownerOnly();
  if (denied) return denied;
  const url = new URL(request.url);
  const clear = oauthCookie(request.url, "", 0);
  const verifier = checkState(readCookie(request, OAUTH_COOKIE), url.searchParams.get("state"));
  if (!verifier) {
    return Response.json(
      { ok: false, error: { code: "bad_state", message: "That sign-in was not started here or has expired. Try again." } },
      { status: 400, headers: { "set-cookie": clear } },
    );
  }
  const back = (result: string) =>
    new Response(null, { status: 302, headers: { location: `${url.origin}/settings?tab=connections&google=${result}`, "set-cookie": clear } });

  const code = url.searchParams.get("code");
  if (!code) return back("denied"); // the owner pressed Cancel on Google's screen

  const connected = await run(async () => {
    const account = await finishSignIn({ code, verifier, requestUrl: request.url });
    const hook = webhookAddress(request.url);
    // The watch also makes the calendar. Without a public URL the cron pull keeps it in step.
    const watched = hook ? await startWatch(hook) : null;
    if (watched && !watched.ok) console.error(`[google/callback] watch: ${watched.error.code}`);
    return account;
  });
  if (!connected.ok) {
    console.error(`[google/callback] ${connected.error.code}`);
    return back(connected.error.code === "not_configured" ? "not_configured" : "error");
  }
  after(async () => {
    const pushed = await pushAll();
    const pulled = await pullCalendar();
    for (const r of [pushed, pulled]) if (!r.ok) console.error(`[google/callback] first sync: ${r.error.code}`);
  });
  return back("connected");
}
