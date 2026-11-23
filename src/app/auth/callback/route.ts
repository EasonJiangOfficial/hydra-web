import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/auth/gate";
import { createServerClient } from "@/lib/supabase/server";

/**
 * Email-link sign-in (PKCE). The link's code becomes a session here; the code verifier is the
 * cookie signInWithOtp set in this browser. The database decides who the owner is; anyone else is
 * signed straight back out. The owner lands on the passkey step, which finishes the sign-in.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url), { status: 303 });
  const code = searchParams.get("code");
  if (!code) return to("/login?error=link");
  try {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return to("/login?error=link");
    const { data: owner, error: ownerError } = await supabase.rpc("is_owner");
    if (ownerError || owner !== true) {
      await supabase.auth.signOut({ scope: "local" });
      return to("/login");
    }
  } catch (error) {
    console.error(`[auth/callback] ${(error as Error).message}`);
    return to("/login?error=link");
  }
  return to(`/login?step=passkey&next=${encodeURIComponent(safeNext(searchParams.get("next")))}`);
}
