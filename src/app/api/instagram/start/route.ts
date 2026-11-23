import { MissingEnvError } from "@/lib/bank/env";
import { startSignIn } from "@/lib/instagram/oauth";
import { fail, ownerOnly } from "../../google/respond";
import { instagramCookie } from "../cookie";

/** GET ?from=settings|brand: the owner's "Connect Instagram" link. Sends the browser to Meta's Unified login dialog (config_id). */
export async function GET(request: Request) {
  const denied = await ownerOnly();
  if (denied) return denied;
  const from = new URL(request.url).searchParams.get("from") === "settings" ? "settings" : "brand";
  let started: ReturnType<typeof startSignIn>;
  try {
    started = startSignIn(request.url, from);
  } catch (error) {
    if (error instanceof MissingEnvError) return fail(503, "not_configured", error.message);
    throw error;
  }
  return new Response(null, {
    status: 302,
    headers: { location: started.url, "set-cookie": instagramCookie(request.url, started.cookie, 600), "cache-control": "no-store" },
  });
}
