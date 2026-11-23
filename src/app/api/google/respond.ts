import { MissingEnvError } from "@/lib/bank/env";
import { NotOwnerError, requireOwner } from "@/lib/bank/server";
import { OAUTH_COOKIE } from "@/lib/google/oauth";

/** Shared by the Google routes (not a route: Next only serves route.ts). */

export const fail = (status: number, code: string, message: string) => Response.json({ ok: false, error: { code, message } }, { status });

/** null for the signed-in owner, else the refusal to return. */
export async function ownerOnly(): Promise<Response | null> {
  try {
    await requireOwner();
    return null;
  } catch (error) {
    if (error instanceof NotOwnerError) return fail(403, "not_owner", "Sign in as the owner");
    if (error instanceof MissingEnvError) return fail(503, "not_configured", error.message);
    throw error;
  }
}

/** The sign-in cookie: httpOnly, only sent to /api/google, Lax so Google's redirect back carries it. */
export function oauthCookie(requestUrl: string, value: string, maxAge: number): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return `${OAUTH_COOKIE}=${value}; Path=/api/google; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function readCookie(request: Request, name: string): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** Where Google sends calendar push notifications. None for http or localhost (Google cannot reach it). */
export function webhookAddress(requestUrl: string): string | null {
  const { protocol, hostname, origin } = new URL(requestUrl);
  if (protocol !== "https:" || /^(localhost|127\.|\[::1\])/.test(hostname)) return null;
  return `${origin}/api/google/calendar/webhook`;
}
