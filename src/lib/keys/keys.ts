import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Connector API keys (DESIGN.md section 11): random, shown once, stored as SHA-256, scoped,
 * revocable, rate limited per key. The database does the check (`api_key_authenticate`, 0080).
 * A key is `hyd_ugc_` + 40 base64url characters (240 random bits).
 */
export const KEY_PREFIX = "hyd_ugc_";
export const UGC_WRITE = "ugc:write";
const KEY_PATTERN = /^hyd_ugc_[A-Za-z0-9_-]{40}$/;

export function generateApiKey(): { secret: string; prefix: string; hash: string } {
  const secret = KEY_PREFIX + randomBytes(30).toString("base64url");
  return { secret, prefix: secret.slice(0, KEY_PREFIX.length + 4), hash: hashApiKey(secret) };
}

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** The key in `Authorization: Bearer <key>`, or null when absent or not shaped like a key. */
export function bearerKey(authorization: string | null): string | null {
  const match = authorization?.trim().match(/^Bearer\s+(\S+)$/i);
  return match && KEY_PATTERN.test(match[1]) ? match[1] : null;
}

export type KeyCheck =
  | { status: "ok"; keyId: string }
  | { status: "invalid" | "revoked" | "forbidden" | "error" }
  | { status: "rate_limited"; retryAfterSeconds: number };

/** Check a presented key for `scope` on the service-role client. Counts toward its rate limit. */
export async function checkApiKey(db: SupabaseClient, secret: string, scope: string): Promise<KeyCheck> {
  const { data, error } = await db
    .rpc("api_key_authenticate", { p_key_hash: hashApiKey(secret), p_scope: scope })
    .maybeSingle();
  if (error || !data) return { status: "error" };
  const row = data as { key_id: string | null; status: string; retry_after_seconds: number | null };
  switch (row.status) {
    case "ok":
      return { status: "ok", keyId: row.key_id! };
    case "rate_limited":
      return { status: "rate_limited", retryAfterSeconds: row.retry_after_seconds ?? 60 };
    case "invalid":
    case "revoked":
    case "forbidden":
      return { status: row.status };
    default:
      return { status: "error" };
  }
}
