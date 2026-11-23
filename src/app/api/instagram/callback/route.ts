import { after } from "next/server";
import { run } from "@/lib/instagram/client";
import { checkState, finishSignIn, IG_OAUTH_COOKIE } from "@/lib/instagram/oauth";
import { syncInstagram } from "@/lib/instagram/sync";
import { ownerOnly, readCookie } from "../../google/respond";
import { instagramCookie } from "../cookie";

/**
 * GET: Meta sends the owner back here. The state must match the cookie set by /start before any code is
 * exchanged; the cookie is cleared on every answer, so a state works once. Then: store the token sealed,
 * go back where the owner started, and (after the response) take the first sync.
 */
export async function GET(request: Request) {
  const denied = await ownerOnly();
  if (denied) return denied;
  const url = new URL(request.url);
  const clear = instagramCookie(request.url, "", 0);
  const from = checkState(readCookie(request, IG_OAUTH_COOKIE), url.searchParams.get("state"));
  if (!from) {
    return Response.json(
      { ok: false, error: { code: "bad_state", message: "That sign-in was not started here or has expired. Try again." } },
      { status: 400, headers: { "set-cookie": clear } },
    );
  }
  const page = from === "settings" ? "/settings?tab=connections&" : "/brand?";
  const back = (result: string) => new Response(null, { status: 302, headers: { location: `${url.origin}${page}instagram=${result}`, "set-cookie": clear } });

  const code = url.searchParams.get("code");
  if (!code) return back("denied"); // the owner pressed Cancel (error=access_denied)

  const connected = await run(() => finishSignIn({ code, requestUrl: request.url }));
  if (!connected.ok) {
    console.error(`[instagram/callback] ${connected.error.code}`);
    return back(connected.error.code === "not_configured" ? "not_configured" : "error");
  }
  after(async () => {
    const first = await run(() => syncInstagram());
    if (!first.ok) console.error(`[instagram/callback] first sync: ${first.error.code}`);
  });
  return back("connected");
}
