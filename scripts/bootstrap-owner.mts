/**
 * Creates the one Hydra owner. Idempotent: safe to run again.
 *   node --experimental-strip-types scripts/bootstrap-owner.mts
 * (Node 22.18+ / 23.6+ strip types by default; the flag keeps older 22.x working.)
 * Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, HYDRA_OWNER_EMAIL from the environment,
 * or from .env.local and then .env when present. A value already set in the environment wins.
 * Never prints keys.
 */
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
if (existsSync(".env")) process.loadEnvFile(".env");

function need(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

const url = need("NEXT_PUBLIC_SUPABASE_URL");
const secret = need("SUPABASE_SECRET_KEY");
const email = need("HYDRA_OWNER_EMAIL").toLowerCase();

const supabase = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

async function findUser() {
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit || data.users.length < 200) return hit ?? null;
  }
}

let user = await findUser();
if (!user) {
  const { data, error } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
  user = data.user;
  console.log(`owner user: created ${user.id}`);
} else if (!user.email_confirmed_at) {
  const { error } = await supabase.auth.admin.updateUserById(user.id, { email_confirm: true });
  if (error) throw error;
  console.log(`owner user: exists ${user.id}, email confirmed now`);
} else {
  console.log(`owner user: exists ${user.id}`);
}

const { data: result, error } = await supabase.rpc("bootstrap_owner", { p_user_id: user.id });
if (error) {
  console.error(`app_owner: failed: ${error.message}`);
  process.exit(1);
}
console.log(`app_owner + settings: ${result}`);
