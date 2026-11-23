import { MissingEnvError } from "@/lib/bank/env";
import { startSignIn } from "@/lib/google/oauth";
import { fail, oauthCookie, ownerOnly } from "../respond";

/** GET: the owner's "Connect Google" link. Sends the browser to Google's consent screen (PKCE). */
export async function GET(request: Request) {
  const denied = await ownerOnly();
  if (denied) return denied;
  let started: ReturnType<typeof startSignIn>;
  try {
    started = startSignIn(request.url);
  } catch (error) {
    if (error instanceof MissingEnvError) return fail(503, "not_configured", error.message);
    throw error;
  }
  return new Response(null, {
    status: 302,
    headers: { location: started.url, "set-cookie": oauthCookie(request.url, started.cookie, 600), "cache-control": "no-store" },
  });
}
