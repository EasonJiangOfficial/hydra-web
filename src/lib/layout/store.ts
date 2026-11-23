import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { BREAKPOINTS, itemsSchema, type Breakpoint } from "./model";

/** Database access for dashboard_layouts. Takes a client so tests can fake it; actions.ts passes the signed-in one. */

const TABLE = "dashboard_layouts";

/** What a row holds. `items` is unvalidated on purpose: the reader runs `normalizeItems` on it. */
export type LayoutRow = { items: unknown; updatedAt: string };

export type SaveResult =
  | { ok: true; updatedAt: string }
  /** Someone else saved (or reset) first. `current` is the newer layout, null when it was reset. */
  | { ok: false; reason: "conflict"; current: LayoutRow | null }
  | { ok: false; reason: "invalid" | "auth" | "error" };

export type ResetResult = { ok: true } | { ok: false; reason: "invalid" | "auth" | "error" };

export const saveInputSchema = z.object({
  breakpoint: z.enum(BREAKPOINTS),
  items: itemsSchema,
  /** The `updatedAt` this tab last saw; null when it saw no saved row. */
  expectedUpdatedAt: z.string().min(1).max(64).nullable(),
});
export type SaveInput = z.infer<typeof saveInputSchema>;

export const resetInputSchema = z.object({ breakpoint: z.enum(BREAKPOINTS) });

type Row = { items: unknown; updated_at: string };

async function readRow(db: SupabaseClient, userId: string, breakpoint: Breakpoint): Promise<LayoutRow | null> {
  const { data } = await db
    .from(TABLE)
    .select("items, updated_at")
    .eq("user_id", userId)
    .eq("breakpoint", breakpoint)
    .maybeSingle<Row>();
  return data ? { items: data.items, updatedAt: data.updated_at } : null;
}

/** Both layouts, null where nothing is saved. RLS already limits the rows to the owner. */
export async function loadLayoutRows(db: SupabaseClient): Promise<Record<Breakpoint, LayoutRow | null>> {
  const out: Record<Breakpoint, LayoutRow | null> = { desktop: null, phone: null };
  const { data } = await db.from(TABLE).select("breakpoint, items, updated_at").returns<(Row & { breakpoint: Breakpoint })[]>();
  for (const r of data ?? []) if (r.breakpoint in out) out[r.breakpoint] = { items: r.items, updatedAt: r.updated_at };
  return out;
}

/**
 * Compare-and-set save. With `expected` null it inserts and loses to any existing row; otherwise it
 * updates only the row whose `updated_at` is still `expected`. The `updated_at` text goes back to
 * the database exactly as it came out (microseconds and all), never through a JS Date.
 */
export async function saveLayoutRow(db: SupabaseClient, userId: string, input: SaveInput): Promise<SaveResult> {
  const { breakpoint, items, expectedUpdatedAt } = input;
  if (expectedUpdatedAt === null) {
    const { data, error } = await db
      .from(TABLE)
      .insert({ user_id: userId, breakpoint, items })
      .select("updated_at")
      .single<{ updated_at: string }>();
    if (!error && data) return { ok: true, updatedAt: data.updated_at };
    if (error?.code === "23505") return { ok: false, reason: "conflict", current: await readRow(db, userId, breakpoint) };
    return { ok: false, reason: "error" };
  }
  const { data, error } = await db
    .from(TABLE)
    .update({ items })
    .eq("user_id", userId)
    .eq("breakpoint", breakpoint)
    .eq("updated_at", expectedUpdatedAt)
    .select("updated_at")
    .returns<{ updated_at: string }[]>();
  if (error) return { ok: false, reason: "error" };
  if (data && data.length > 0) return { ok: true, updatedAt: data[0].updated_at };
  return { ok: false, reason: "conflict", current: await readRow(db, userId, breakpoint) };
}

/** Reset deletes the row, so the default layout applies and the next save inserts. */
export async function resetLayoutRow(db: SupabaseClient, userId: string, breakpoint: Breakpoint): Promise<ResetResult> {
  const { error } = await db.from(TABLE).delete().eq("user_id", userId).eq("breakpoint", breakpoint);
  return error ? { ok: false, reason: "error" } : { ok: true };
}
