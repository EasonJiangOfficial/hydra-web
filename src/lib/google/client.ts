import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptToken, encryptToken, TokenDecryptError } from "@/lib/bank/crypto";
import { InvalidEnvError, MissingEnvError } from "@/lib/bank/env";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The one Google sign-in: env, encrypted tokens, refresh, and the request helper every Gmail and
 * Calendar function uses. Server only and NOT an action: nothing here checks the caller (routines
 * run with no session), so never export it from a "use server" file. Tokens are sealed with the
 * Plaid helper (AES-256-GCM, AAD = the account row id) and only service_role reads them.
 */

export type GoogleResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export class GoogleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleError";
  }
}

/** Google answered with an error. `reason` is Google's own (notFound, insufficientPermissions, ...). */
export class GoogleApiError extends GoogleError {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super("google_error", `Google refused the request (${status} ${reason})`);
  }
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EXPIRY_SKEW_MS = 60_000;

/** GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (a Web application OAuth client). Missing: fail closed. */
export function googleEnv(env: Record<string, string | undefined> = process.env) {
  const get = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new MissingEnvError(name);
    return value;
  };
  return { clientId: get("GOOGLE_CLIENT_ID"), clientSecret: get("GOOGLE_CLIENT_SECRET") };
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/** POST to Google's token endpoint. A refusal carries Google's error code (invalid_grant, ...). */
export async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
  if (!res.ok || typeof body.access_token !== "string") {
    throw new GoogleError(body.error === "invalid_grant" ? "reauth_required" : "google_error", `Google token request failed (${body.error ?? res.status})`);
  }
  return body as TokenResponse;
}

export interface GoogleAccount {
  id: string;
  email: string;
  scopes: string;
  status: "active" | "reauth_required";
}

interface SealedAccount extends GoogleAccount {
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
}

const expiresAt = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

export async function loadAccount(db: SupabaseClient): Promise<SealedAccount | null> {
  const { data, error } = await db
    .from("google_accounts")
    .select("id, email, scopes, status, access_token, access_expires_at, refresh_token")
    .maybeSingle();
  if (error) throw new Error(`google account: ${error.message}`);
  return data as SealedAccount | null;
}

/** Save a fresh sign-in. A different Google account replaces the old one (its sync state goes with it). */
export async function saveSignIn(db: SupabaseClient, email: string, tokens: TokenResponse): Promise<GoogleAccount> {
  if (!tokens.refresh_token) throw new GoogleError("no_refresh_token", "Google sent no refresh token. Sign in again.");
  const existing = await loadAccount(db);
  if (existing && existing.email !== email) {
    const { error } = await db.from("google_accounts").delete().eq("id", existing.id);
    if (error) throw new Error(`google account: ${error.message}`);
  }
  const id = existing?.email === email ? existing.id : crypto.randomUUID();
  const row = {
    id,
    one_sign_in: true,
    email,
    scopes: tokens.scope ?? "",
    access_token: encryptToken(tokens.access_token, id),
    access_expires_at: expiresAt(tokens.expires_in),
    refresh_token: encryptToken(tokens.refresh_token, id),
    status: "active",
    last_error: null,
  };
  const { error } = await db.from("google_accounts").upsert(row, { onConflict: "id" });
  if (error) throw new Error(`google account: ${error.message}`);
  return { id, email, scopes: row.scopes, status: "active" };
}

/**
 * A live access token, refreshed when it is within a minute of expiry (or `force`). Google
 * refusing the refresh token (revoked, expired) marks the account `reauth_required`.
 */
export async function accessToken(db: SupabaseClient, force = false): Promise<{ account: GoogleAccount; token: string }> {
  const { clientId, clientSecret } = googleEnv();
  const sealed = await loadAccount(db);
  if (!sealed) throw new GoogleError("not_connected", "Connect Google first");
  if (sealed.status !== "active") throw new GoogleError("reauth_required", "Sign in to Google again");
  const account: GoogleAccount = { id: sealed.id, email: sealed.email, scopes: sealed.scopes, status: sealed.status };
  if (!force && Date.parse(sealed.access_expires_at) - EXPIRY_SKEW_MS > Date.now()) {
    return { account, token: decryptToken(sealed.access_token, sealed.id) };
  }
  let fresh: TokenResponse;
  try {
    fresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: decryptToken(sealed.refresh_token, sealed.id),
      client_id: clientId,
      client_secret: clientSecret,
    });
  } catch (error) {
    if (error instanceof GoogleError && error.code === "reauth_required") {
      await db.from("google_accounts").update({ status: "reauth_required", last_error: "invalid_grant" }).eq("id", sealed.id);
    }
    throw error;
  }
  const patch: Record<string, string | null> = {
    access_token: encryptToken(fresh.access_token, sealed.id),
    access_expires_at: expiresAt(fresh.expires_in),
    last_error: null,
  };
  if (fresh.refresh_token) patch.refresh_token = encryptToken(fresh.refresh_token, sealed.id);
  const { error } = await db.from("google_accounts").update(patch).eq("id", sealed.id);
  if (error) throw new Error(`google account: ${error.message}`);
  return { account, token: fresh.access_token };
}

export interface ApiInit {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/** A Google REST call as the signed-in account. One retry after a 401 with a refreshed token. */
export async function googleApi<T>(url: string, init: ApiInit = {}, db: SupabaseClient = createAdminClient()): Promise<T> {
  const target = new URL(url);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) target.searchParams.set(k, String(v));
  let { token } = await accessToken(db);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(target, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (res.status === 401 && attempt === 0) {
      token = (await accessToken(db, true)).token;
      continue;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[]; status?: string } };
      throw new GoogleApiError(res.status, body.error?.errors?.[0]?.reason ?? body.error?.status ?? "error");
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Send, trash and delete need the owner's yes: the agent's confirm gate (or a routine's approval)
 * passes the id of its agent_approvals row, and that row must say yes (approved, or done: claimed
 * for this run). No real yes, no call to Google.
 * ponytail: checks the row's yes, not that its tool and input match this call; the gate that
 * claims the row owns that match.
 */
export async function requireApproval(approvalId: unknown, db: SupabaseClient = createAdminClient()): Promise<string> {
  const id = typeof approvalId === "string" ? approvalId.trim() : "";
  const refuse = () => new GoogleError("approval_required", "This needs the owner's yes first");
  if (!UUID_RE.test(id)) throw refuse();
  const { data, error } = await db.from("agent_approvals").select("id, status").eq("id", id).maybeSingle();
  if (error) throw new Error(`approval: ${error.message}`);
  const status = (data as { status?: string } | null)?.status;
  if (status !== "approved" && status !== "done") throw refuse();
  return id;
}

/** Run a connector function and fold every failure into a GoogleResult. Unknown errors are logged, not shown. */
export async function run<T>(body: () => Promise<T>): Promise<GoogleResult<T>> {
  try {
    return { ok: true, data: await body() };
  } catch (error) {
    if (error instanceof GoogleError) return { ok: false, error: { code: error.code, message: error.message } };
    if (error instanceof MissingEnvError || error instanceof InvalidEnvError) {
      return { ok: false, error: { code: "not_configured", message: error.message } };
    }
    if (error instanceof TokenDecryptError) return { ok: false, error: { code: "reauth_required", message: "Sign in to Google again" } };
    console.error(`[google] ${(error as Error).message}`);
    return { ok: false, error: { code: "internal", message: "Something went wrong" } };
  }
}
