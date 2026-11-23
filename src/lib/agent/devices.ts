import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Hydra Desktop pairing (DESIGN.md 11: keys random, shown once, SHA-256 stored, scoped, revocable).
 * The owner makes a one-time code in a signed-in session; the Mac app trades it for a device key.
 * Rate limited (agent_rate_hit, one-minute windows): each device per route kind, and the exchange
 * per IP and in total.
 */

/** agent: turns and state; mcp: the Hydra tools; relay: the Mac serves relay turns (the Mac is the brain). */
export const DEVICE_SCOPES = ["agent", "mcp", "relay"] as const;
export type DeviceScope = (typeof DEVICE_SCOPES)[number];
/** mac: Hydra Desktop. brain: Hydra's server; while one is online it takes every relay turn (0121). Set once, by the pairing code. */
export const DEVICE_ROLES = ["mac", "brain"] as const;
export type DeviceRole = (typeof DEVICE_ROLES)[number];
export interface Device {
  id: string;
  scopes: DeviceScope[];
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const CODE_TTL_MS = 10 * 60_000;
export const KEY_PREFIX = "hyd_";

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function newPairingCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export function newDeviceKey(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Owner session: a one-time code for one new device. */
export async function createPairingCode(
  db: SupabaseClient,
  input: { name?: string; scopes?: DeviceScope[]; role?: DeviceRole },
  now = new Date(),
): Promise<{ code: string; expiresAt: string }> {
  const code = newPairingCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString();
  const { error } = await db.from("agent_pairing_codes").insert({
    code_hash: sha256(code),
    name: input.name?.trim() || (input.role === "brain" ? "Hydra server" : "Hydra Desktop"),
    scopes: input.scopes?.length ? input.scopes : [...DEVICE_SCOPES],
    role: input.role ?? "mac",
    expires_at: expiresAt,
  });
  if (error) throw new Error(`pairing code: ${error.message}`);
  return { code, expiresAt };
}

/** Service role: the role a live code would give (null: unknown, used or expired). Does not use it up. */
export async function pairingCodeRole(admin: SupabaseClient, code: string): Promise<DeviceRole | null> {
  const { data, error } = await admin.rpc("agent_pairing_code_role", { p_code_hash: sha256(normalizeCode(code)) });
  if (error) throw new Error(`pairing role: ${error.message}`);
  return (data as DeviceRole | null) ?? null;
}

/** Service role: trade a code for a device key. The key is returned once and never stored. */
export async function exchangePairingCode(admin: SupabaseClient, code: string, name: string): Promise<{ deviceId: string; key: string } | null> {
  const key = newDeviceKey();
  const { data, error } = await admin.rpc("agent_pair_exchange", {
    p_code_hash: sha256(normalizeCode(code)),
    p_key_hash: sha256(key),
    p_name: name,
  });
  if (error) throw new Error(`pairing: ${error.message}`);
  return data ? { deviceId: data as string, key } : null;
}

/** Service role: the live device for a bearer key (revoked or unknown = null). Moves last_seen_at. */
export async function authDevice(admin: SupabaseClient, key: string): Promise<Device | null> {
  if (!key.startsWith(KEY_PREFIX) || key.length > 200) return null;
  const { data, error } = await admin.rpc("agent_device_auth", { p_key_hash: sha256(key) });
  if (error) throw new Error(`device auth: ${error.message}`);
  const row = (data as Device[] | null)?.[0];
  return row ? { id: row.id, scopes: row.scopes } : null;
}

/** Requests per minute. A turn is a paid model call, so it gets the tight limit. The relay streams a
 * Mac turn as many small event posts, so it gets the loose one. A device's voice costs Fish Audio
 * credits (up to 1000 chars a request), so a leaked key speaks at most 20 sentences a minute. */
export const RATE_LIMITS = { deviceTurn: 12, deviceOther: 120, deviceRelay: 600, deviceTts: 20, pairPerIp: 10, pairAll: 30 } as const;

/** Service role: one hit on a bucket. 0 = allowed, else seconds until the window resets. */
export async function rateHit(admin: SupabaseClient, bucket: string, limit: number): Promise<number> {
  const { data, error } = await admin.rpc("agent_rate_hit", { p_bucket: bucket, p_limit: limit });
  if (error) throw new Error(`rate limit: ${error.message}`);
  return typeof data === "number" ? data : 0;
}

export const rateLimited = (retryAfter: number) =>
  Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": String(retryAfter) } });

/** The client IP behind Vercel's proxy (its first x-forwarded-for entry). */
export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) || "unknown";
}

export function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match ? match[1] : null;
}
