import { IG_OAUTH_COOKIE } from "@/lib/instagram/oauth";

/** The sign-in cookie: httpOnly, only sent to /api/instagram, Lax so Instagram's redirect back carries it. Not a route. */
export function instagramCookie(requestUrl: string, value: string, maxAge: number): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return `${IG_OAUTH_COOKIE}=${value}; Path=/api/instagram; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
