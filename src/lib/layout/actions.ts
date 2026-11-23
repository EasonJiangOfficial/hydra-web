"use server";

import { createServerClient } from "@/lib/supabase/server";
import {
  loadLayoutRows,
  resetInputSchema,
  resetLayoutRow,
  saveInputSchema,
  saveLayoutRow,
  type LayoutRow,
  type ResetResult,
  type SaveInput,
  type SaveResult,
} from "./store";
import type { Breakpoint } from "./model";

/**
 * Typed actions for the dashboard layout. The interface and the Hydra Agent call the same ones.
 * They act as the signed-in user: RLS keeps every row to the owner.
 */

async function signedIn() {
  const db = await createServerClient();
  const { data } = await db.auth.getClaims();
  const userId = data?.claims.sub;
  return userId ? { db, userId } : null;
}

/** Both saved layouts (null where none is saved). Run `normalizeItems` on `items` before use. */
export async function loadLayouts(): Promise<Record<Breakpoint, LayoutRow | null>> {
  const ctx = await signedIn();
  return ctx ? loadLayoutRows(ctx.db) : { desktop: null, phone: null };
}

/**
 * Save one breakpoint's layout. `expectedUpdatedAt` is the `updatedAt` the caller last saw (null if
 * none). A stale value returns `conflict` with the newer layout; the caller reloads it and drops its own.
 */
export async function saveLayout(input: SaveInput): Promise<SaveResult> {
  const parsed = saveInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const ctx = await signedIn();
  if (!ctx) return { ok: false, reason: "auth" };
  return saveLayoutRow(ctx.db, ctx.userId, parsed.data);
}

/** Back to the default layout for one breakpoint. */
export async function resetLayout(input: { breakpoint: Breakpoint }): Promise<ResetResult> {
  const parsed = resetInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const ctx = await signedIn();
  if (!ctx) return { ok: false, reason: "auth" };
  return resetLayoutRow(ctx.db, ctx.userId, parsed.data.breakpoint);
}
