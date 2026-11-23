/* Helpers for the local-Supabase auth flow (SUPABASE_E2E=1). Local stack only: never point at a hosted project. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Page } from "@playwright/test";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

/** Signs the owner in through the session cookie (an email code verified the way the login page does). */
export async function signIn(page: Page, baseURL: string) {
  const jar = new Map<string, string>();
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "", {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (set) => set.forEach((c) => jar.set(c.name, c.value)),
    },
  });
  // Parallel workers each ask for a code, and a new code replaces the last one: retry until one holds.
  for (let tries = 0; ; tries++) {
    const { error } = await supabase.auth.verifyOtp({ email: ownerEmail(), token: await emailCode(ownerEmail()), type: "email" });
    if (!error) break;
    if (tries === 5) throw error;
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 600));
  }
  await page.context().addCookies([...jar].map(([name, value]) => ({ name, value, url: baseURL })));
}

export const ownerEmail = () => process.env.HYDRA_OWNER_EMAIL ?? "";

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) throw new Error("SUPABASE_E2E runs against local Supabase only");
  return createClient(url, process.env.SUPABASE_SECRET_KEY ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function bootstrapOwner(): string {
  return execFileSync("node", ["--experimental-strip-types", "scripts/bootstrap-owner.mts"], { encoding: "utf8" });
}

/** Start from an owner with no passkeys, so the "Add a passkey" screen shows. */
export async function deleteOwnerPasskeys() {
  const supabase = admin();
  const { data } = await supabase.auth.admin.listUsers();
  const user = data.users.find((u) => u.email === ownerEmail());
  if (!user) throw new Error("owner missing");
  const { data: keys, error } = await supabase.auth.admin.passkey.listPasskeys({ userId: user.id });
  if (error) throw error;
  for (const key of keys ?? []) await supabase.auth.admin.passkey.deletePasskey({ userId: user.id, passkeyId: key.id });
  await supabase.from("settings").update({ time_zone: null }).eq("user_id", user.id);
  return user.id;
}

export async function ownerTimeZone(userId: string) {
  const { data } = await admin().from("settings").select("time_zone").eq("user_id", userId).single();
  return data?.time_zone as string | null;
}

/** Chrome DevTools virtual authenticator: a platform passkey with resident keys and user verification. */
export async function addVirtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

/**
 * A fresh 6-digit email code for the owner. Local Supabase keeps the email template it started with, so its mail
 * may lack the code; the admin API issues a new code (replacing the one the form asked for) that verifyOtp accepts.
 */
export async function emailCode(email: string): Promise<string> {
  const { data, error } = await admin().auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  return data.properties.email_otp;
}
