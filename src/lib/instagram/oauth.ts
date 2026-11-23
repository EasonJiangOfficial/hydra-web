import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptToken, encryptToken } from "@/lib/bank/crypto";
import { tokenKey } from "@/lib/bank/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { assignedAccount, AUTHORIZE_URL, exchangeCode, instagramEnv } from "./client";
import type { InstagramView } from "./model";

/**
 * The one Instagram sign-in (Instagram API with Unified Login: Facebook Login for Business with the Meta app's
 * configuration, config_id): authorization code, then a business integration system user token. The flow has no
 * PKCE, so the state alone guards the callback: it rides in an httpOnly cookie scoped to /api/instagram, the
 * callback refuses any state that does not match it, and clears the cookie, so a state works once. The token is
 * stored sealed (AAD = the row id); only service_role reads it.
 */

export const IG_OAUTH_COOKIE = "hydra_instagram_oauth";
export const TABLE = "instagram_connections";
export type ReturnTo = "brand" | "settings";

/** The redirect URI for this host. Register it exactly in the Unified login configuration and Facebook Login for Business. */
export const redirectUri = (requestUrl: string) => `${new URL(requestUrl).origin}/api/instagram/callback`;

/** The consent URL and the cookie value (`state.returnTo`) the callback checks. */
export function startSignIn(requestUrl: string, returnTo: ReturnTo): { url: string; cookie: string } {
  const { appId, configId } = instagramEnv();
  tokenKey(); // no token key, no sign-in: the callback could not store the token
  const state = randomBytes(24).toString("base64url");
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: appId,
    config_id: configId,
    redirect_uri: redirectUri(requestUrl),
    response_type: "code",
    state,
  }).toString();
  return { url: url.toString(), cookie: `${state}.${returnTo}` };
}

/** Where to send the owner back when `state` matches the cookie, else null (constant-time compare). */
export function checkState(cookie: string | undefined, state: string | null): ReturnTo | null {
  const [expected, returnTo] = (cookie ?? "").split(".");
  if (!expected || !state || (returnTo !== "brand" && returnTo !== "settings")) return null;
  const a = Buffer.from(expected);
  const b = Buffer.from(state);
  return a.length === b.length && timingSafeEqual(a, b) ? returnTo : null;
}

export interface SealedConnection {
  id: string;
  ig_user_id: string;
  username: string;
  access_token: string;
  /** A fresh uuid with every stored token: the sync's compare-and-set key (the sealed token never rides in a filter). */
  token_id: string;
  /** What the sign-in granted (comma-separated); empty when Meta did not say (Unified Login never does). */
  scopes: string;
  /** Null: the token never expires. */
  expires_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  sync_started_at: string | null;
  updated_at: string;
}

export async function loadConnection(db: SupabaseClient): Promise<SealedConnection | null> {
  const { data, error } = await db
    .from(TABLE)
    .select("id, ig_user_id, username, access_token, token_id, scopes, expires_at, last_synced_at, last_error, sync_started_at, updated_at")
    .maybeSingle();
  if (error) throw new Error(`instagram connection: ${error.message}`);
  return data as SealedConnection | null;
}

/**
 * Exchange the code, find the Instagram account the sign-in shared, store the token sealed with its expiry (null:
 * never). Reconnecting (another account too) updates the one row and clears its error; posts and follower counts
 * already saved stay. The sync lease is left alone, so a reconnect never lets a second sync start beside a running one.
 */
export async function finishSignIn(input: { code: string; requestUrl: string }): Promise<{ username: string }> {
  const token = await exchangeCode({ code: input.code, redirectUri: redirectUri(input.requestUrl) });
  const me = await assignedAccount(token.accessToken);
  const db = createAdminClient();
  const id = (await loadConnection(db))?.id ?? crypto.randomUUID();
  const { error } = await db.from(TABLE).upsert(
    {
      id,
      one_connection: true,
      ig_user_id: me.userId,
      username: me.username,
      scopes: "",
      access_token: encryptToken(token.accessToken, id),
      token_id: crypto.randomUUID(),
      expires_at: token.expiresAt?.toISOString() ?? null,
      last_error: null,
      // The sync lease stays: a sync running now keeps it, its writes miss the new token, and it frees the lease.
    },
    { onConflict: "one_connection" },
  );
  if (error) throw new Error(`instagram connection: ${error.message}`);
  return { username: me.username };
}

/** Forget the Instagram sign-in: delete the token row. The posts and follower counts it synced stay. */
export async function disconnect(db: SupabaseClient = createAdminClient()): Promise<{ disconnected: boolean }> {
  const { data, error } = await db.from(TABLE).delete().eq("one_connection", true).select("id");
  if (error) throw new Error(`instagram connection: ${error.message}`);
  return { disconnected: ((data ?? []) as unknown[]).length > 0 };
}

/** The variables Connect still needs on the host (an unusable HYDRA_TOKEN_KEY counts). Empty: Connect can start. Never throws. */
export function instagramMissing(env: Record<string, string | undefined> = process.env): string[] {
  const missing = ["META_APP_ID", "META_APP_SECRET", "INSTAGRAM_CONFIG_ID"].filter((name) => !env[name]?.trim());
  try {
    tokenKey(env);
  } catch {
    missing.push("HYDRA_TOKEN_KEY");
  }
  return missing;
}

/** The connection as the pages show it, read as the caller (RLS: the owner, or hydra_ro). A failed read shows as not connected. */
export async function loadInstagramView(db: SupabaseClient): Promise<InstagramView> {
  const { data, error } = await db.from(TABLE).select("username, last_synced_at, last_error").maybeSingle();
  if (error) console.error(`[instagram] view: ${error.message}`);
  const row = (error ? null : data) as { username: string; last_synced_at: string | null; last_error: string | null } | null;
  return { missing: instagramMissing(), username: row?.username ?? null, lastSyncedAt: row?.last_synced_at ?? null, lastError: row?.last_error ?? null };
}

/** The stored token and its account for read-only calls (thumbnails), or null when there is none or it cannot be read. Never throws. */
export async function storedToken(): Promise<{ token: string; igUserId: string } | null> {
  try {
    const row = await loadConnection(createAdminClient());
    if (!row || row.last_error === "reauth_required" || (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now())) return null;
    return { token: decryptToken(row.access_token, row.id), igUserId: row.ig_user_id };
  } catch {
    return null;
  }
}
