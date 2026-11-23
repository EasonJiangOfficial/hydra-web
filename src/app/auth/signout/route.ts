import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

/** POST only: a GET (link prefetch, image tag) must never sign the owner out. */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerClient();
    await supabase.auth.signOut({ scope: "local" });
  } catch (error) {
    console.error(`[signout] ${(error as Error).message}`);
  }
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
