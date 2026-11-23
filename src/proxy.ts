import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isOwnerEmail, isPublicPath, isSelfAuthPath, loginPath, movedPath, signedInLoginRedirect } from "@/lib/auth/gate";
import { ownerEmail, publicEnv } from "@/lib/supabase/env";

/**
 * Auth gate. Refreshes the Supabase session cookie and lets only the owner through.
 * The decision uses getClaims() (JWT signature verified), never unverified getSession() data.
 * Missing env fails closed: every protected path goes to /login.
 * A signed-in owner who opens /login goes to `next` or the Dashboard (signedInLoginRedirect).
 * Self-auth API routes (isSelfAuthPath: bearer keys, CRON_SECRET, signed webhooks) still get the
 * session refresh but are never redirected: their handlers answer 401 themselves.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // A moved page answers before the gate, so the login's `next` is already the new place.
  const moved = movedPath(pathname, search);
  if (moved) return NextResponse.redirect(new URL(moved, request.url));
  const isLogin = pathname === "/login";
  if (isPublicPath(pathname) && !isLogin) return NextResponse.next();
  const selfAuth = isSelfAuthPath(pathname);

  const toLogin = () => NextResponse.redirect(new URL(loginPath(pathname, search), request.url));

  let env: ReturnType<typeof publicEnv>;
  let owner: string;
  try {
    env = publicEnv();
    owner = ownerEmail();
  } catch (error) {
    console.error(`[proxy] ${(error as Error).message}`);
    return isLogin || selfAuth ? NextResponse.next() : toLogin();
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(env.url, env.publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(toSet, headers) {
        toSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers ?? {}).forEach(([key, value]) => response.headers.set(key, value));
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const isOwner = isOwnerEmail(data?.claims?.email, owner);
  const carryCookies = (redirect: NextResponse) => {
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  };

  if (isLogin) {
    const target = signedInLoginRedirect(request.nextUrl.searchParams, isOwner);
    return target ? carryCookies(NextResponse.redirect(new URL(target, request.url))) : response;
  }
  return isOwner || selfAuth ? response : carryCookies(toLogin());
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|sw\\.js$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest)$).*)",
  ],
};
