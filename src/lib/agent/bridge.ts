import "server-only";
import { createServerClient as createSsrServerClient } from "@supabase/ssr";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail, publicEnv } from "@/lib/supabase/env";

/**
 * The owner-session bridge. The engines' typed actions act as the signed-in owner (cookie session,
 * RLS) and nothing else. A paired device (Bearer key) and the cron have no session, so after their
 * own auth they forward the request to the same Hydra route with an owner session minted on the
 * server (admin magic-link token, verified server-side; no email is sent). Every tool therefore
 * runs exactly as it does for the pages. The minted session is cached until shortly before it
 * expires (one verify per hour per instance); it never leaves the server: Set-Cookie is stripped.
 */

let cached: { cookie: string; expiresAt: number } | null = null;

export class BridgeError extends Error {}

async function mintOwnerCookie(): Promise<{ cookie: string; expiresAt: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: ownerEmail() });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) throw new BridgeError(`owner session: ${error?.message ?? "no token"}`);
  const jar = new Map<string, string>();
  const { url, publishableKey } = publicEnv();
  const ssr = createSsrServerClient(url, publishableKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { data: verified, error: verifyError } = await ssr.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (verifyError || !verified.session) throw new BridgeError(`owner session: ${verifyError?.message ?? "no session"}`);
  if (!jar.size) throw new BridgeError("owner session: no cookie");
  return {
    cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
    expiresAt: (verified.session.expires_at ?? 0) * 1000,
  };
}

export async function ownerCookie(now = Date.now()): Promise<string> {
  if (!cached || cached.expiresAt - 5 * 60_000 < now) cached = await mintOwnerCookie();
  return cached.cookie;
}

/** Drop the cached session (a forwarded call came back 401: it was revoked). */
export function forgetOwnerCookie() {
  cached = null;
}

/**
 * Call a Hydra route as the owner. `deviceId` rides along in x-hydra-device as a label only: the
 * owner session is the authority. The response body streams through; Set-Cookie never does.
 */
export async function fetchAsOwner(
  url: URL,
  init: { method: string; headers?: Headers; body?: BodyInit | null; signal?: AbortSignal; deviceId?: string | null },
): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const h of ["authorization", "cookie", "host", "content-length", "connection"]) headers.delete(h);
  headers.set("cookie", await ownerCookie());
  if (init.deviceId) headers.set("x-hydra-device", init.deviceId);
  else headers.delete("x-hydra-device");
  const upstream = await fetch(url, { method: init.method, headers, body: init.body, signal: init.signal, redirect: "manual" });
  if (upstream.status === 401) forgetOwnerCookie();
  const out = new Headers(upstream.headers);
  out.delete("set-cookie");
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

/** Forward a device's request to the same route as the owner. */
export async function forwardAsOwner(request: Request, deviceId: string): Promise<Response> {
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  try {
    return await fetchAsOwner(new URL(request.url), { method: request.method, headers: request.headers, body, signal: request.signal, deviceId });
  } catch (error) {
    if (error instanceof BridgeError) {
      console.error(`[agent] ${error.message}`);
      return Response.json({ error: "owner_session_unavailable" }, { status: 503 });
    }
    throw error;
  }
}
