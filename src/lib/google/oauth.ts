import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { decryptToken } from "@/lib/bank/crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { GoogleError, googleEnv, loadAccount, saveSignIn, tokenRequest, type GoogleAccount } from "./client";

/**
 * One Google sign-in: OAuth 2.0 authorization code with PKCE (S256), offline access. The state and
 * the code verifier ride in an httpOnly cookie scoped to /api/google; the callback refuses any
 * state that does not match it before it exchanges anything.
 */

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  // Labels and trash (threads.modify, threads.trash) need modify.
  "https://www.googleapis.com/auth/gmail.modify",
  // Create the "Hydra" calendar and manage the events on it.
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

export const OAUTH_COOKIE = "hydra_google_oauth";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const b64url = (buf: Buffer) => buf.toString("base64url");

/** The redirect URI for this host. Register it exactly in the Google Cloud console. */
export const redirectUri = (requestUrl: string) => `${new URL(requestUrl).origin}/api/google/callback`;

/** The consent URL and the cookie value (`state.verifier`) the callback checks. */
export function startSignIn(requestUrl: string): { url: string; cookie: string } {
  const { clientId } = googleEnv();
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(requestUrl),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // always returns a refresh token, also on a reconnect
    include_granted_scopes: "true",
    state,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), cookie: `${state}.${verifier}` };
}

/** The code verifier when `state` matches the cookie, else null (constant-time compare). */
export function checkState(cookie: string | undefined, state: string | null): string | null {
  const [expected, verifier] = (cookie ?? "").split(".");
  if (!expected || !verifier || !state) return null;
  const a = Buffer.from(expected);
  const b = Buffer.from(state);
  return a.length === b.length && timingSafeEqual(a, b) ? verifier : null;
}

/** Exchange the code (with its verifier), read the account's email, store the tokens encrypted. */
export async function finishSignIn(input: { code: string; verifier: string; requestUrl: string }): Promise<GoogleAccount> {
  const { clientId, clientSecret } = googleEnv();
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: redirectUri(input.requestUrl),
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  const profile = (await res.json().catch(() => ({}))) as { email?: unknown };
  if (!res.ok || typeof profile.email !== "string") throw new GoogleError("google_error", "Google did not say which account signed in");
  return saveSignIn(createAdminClient(), profile.email.toLowerCase(), tokens);
}

/**
 * Forget the Google sign-in: revoke the refresh token at Google (best effort: a token Google
 * already dropped still gets deleted here), then delete the account row. Its sync state, links and
 * watch channels go with it (cascade). Hydra's own tasks and events stay.
 */
export async function disconnect(): Promise<{ disconnected: boolean }> {
  const db = createAdminClient();
  const account = await loadAccount(db);
  if (!account) return { disconnected: false };
  try {
    await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: decryptToken(account.refresh_token, account.id) }),
    });
  } catch (error) {
    console.error(`[google] revoke: ${(error as Error).message}`);
  }
  const { error } = await db.from("google_accounts").delete().eq("id", account.id);
  if (error) throw new Error(`google account: ${error.message}`);
  return { disconnected: true };
}
