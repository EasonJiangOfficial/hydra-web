"use server";

/**
 * Connector key management for Settings, Connections. Owner only, as the owner (RLS applies).
 * The secret is returned once, by createApiKey; only its SHA-256 is stored.
 */
import { z } from "zod";
import { generateApiKey, UGC_WRITE } from "@/lib/keys/keys";
import { createServerClient } from "@/lib/supabase/server";
import { invalidInput, type ActionResult } from "@/lib/ugc/schemas";

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  rate_limit_per_minute: number;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const COLUMNS = "id, name, prefix, scope, rate_limit_per_minute, created_at, last_used_at, revoked_at";
const createSchema = z.object({ name: z.string().trim().min(1).max(100) });
const idSchema = z.object({ id: z.uuid() });

type Fail = Extract<ActionResult<never>, { ok: false }>;
const fail = (code: Fail["error"]["code"], message: string): Fail => ({ ok: false, error: { code, message } });

async function asOwner<T>(
  run: (db: Awaited<ReturnType<typeof createServerClient>>) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  try {
    const db = await createServerClient();
    const { data: owner, error } = await db.rpc("is_owner");
    if (error || owner !== true) return fail("not_owner", "Only the owner can do this");
    return await run(db);
  } catch (e) {
    return fail("db_error", e instanceof Error ? e.message : "Unexpected error");
  }
}

/** Make a `ugc:write` key. `secret` is shown once and never stored. */
export async function createApiKey(
  input: z.input<typeof createSchema>,
): Promise<ActionResult<{ key: ApiKeyRow; secret: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  return asOwner(async (db) => {
    const { secret, prefix, hash } = generateApiKey();
    const { data, error } = await db
      .from("api_keys")
      .insert({ name: parsed.data.name, prefix, key_hash: hash, scope: UGC_WRITE })
      .select(COLUMNS)
      .single();
    return error ? fail("db_error", error.message) : { ok: true, data: { key: data as ApiKeyRow, secret } };
  });
}

/** Every key, newest first, revoked ones included. Never the hash. */
export async function listApiKeys(): Promise<ActionResult<ApiKeyRow[]>> {
  return asOwner(async (db) => {
    const { data, error } = await db.from("api_keys").select(COLUMNS).order("created_at", { ascending: false });
    return error ? fail("db_error", error.message) : { ok: true, data: (data ?? []) as ApiKeyRow[] };
  });
}

/** Revoke a key: every later call with it gets 401. Revoking twice keeps the first time. */
export async function revokeApiKey(input: z.input<typeof idSchema>): Promise<ActionResult<ApiKeyRow>> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  return asOwner(async (db) => {
    const { data, error } = await db
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", parsed.data.id)
      .is("revoked_at", null)
      .select(COLUMNS)
      .maybeSingle();
    if (error) return fail("db_error", error.message);
    if (data) return { ok: true, data: data as ApiKeyRow };
    const existing = await db.from("api_keys").select(COLUMNS).eq("id", parsed.data.id).maybeSingle();
    if (existing.error) return fail("db_error", existing.error.message);
    return existing.data ? { ok: true, data: existing.data as ApiKeyRow } : fail("not_found", "No such key");
  });
}
