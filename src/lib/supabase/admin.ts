import "server-only";
import { createClient } from "@supabase/supabase-js";
import { MissingEnvError, publicEnv } from "./env";

/** Service-role client. Bypasses RLS: server jobs only. `server-only` breaks any client import at build. */
export function createAdminClient() {
  const { url } = publicEnv();
  const secret = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!secret) throw new MissingEnvError("SUPABASE_SECRET_KEY");
  return createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
