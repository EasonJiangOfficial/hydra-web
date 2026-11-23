"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { trashFile } from "@/lib/activity/files";
import { activityIdOf, withActivity, type WithActivity } from "@/lib/activity/request";
import { createServerClient } from "@/lib/supabase/server";
import { entityId } from "./data";
import type { ActionResult, DocKind, LineTx, Payment, Quarter, TaxDoc } from "./model";

/**
 * Taxes writes as typed actions: owner checked first, input validated, then written as the owner
 * (RLS applies). The page and the Hydra Agent call these. Hydra stores what the owner types; it
 * does not file taxes. Expected failures come back as `{ ok: false, error }`.
 */

class ActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function act<S extends z.ZodType, T>(
  schema: S,
  input: unknown,
  run: (input: z.output<S>, db: SupabaseClient) => Promise<T>,
): Promise<ActionResult<T>> {
  const fail = (code: string, message: string): ActionResult<T> => ({ ok: false, error: { code, message } });
  try {
    const db = await createServerClient();
    const { data: owner, error } = await db.rpc("is_owner");
    if (error || owner !== true) return fail("not_owner", "Sign in as the owner");
    const parsed = schema.safeParse(input);
    if (!parsed.success) return fail("invalid_input", z.prettifyError(parsed.error));
    return { ok: true, data: await run(parsed.data, db) };
  } catch (e) {
    if (e instanceof ActionError) return fail(e.code, e.message);
    console.error(`[taxes] ${(e as Error).message}`);
    return fail("internal", "Something went wrong");
  }
}

const entity = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "an entity slug");
const year = z.number().int().min(2000).max(2100);
const quarter = z.number().int().min(1).max(4);
const id = z.guid();
const BUCKET = "tax-docs";

function check(what: string, error: { message: string; code?: string } | null) {
  if (!error) return;
  if (error.code === "23505") throw new ActionError("conflict", `${what}: that already exists`);
  throw new Error(`${what}: ${error.message}`);
}

/** Set the set-aside rate (basis points, 2500 = 25%) for one entity and year. */
export async function saveRate(input: { entity: string; year: number; rateBps: number }): Promise<ActionResult<{ rateBps: number }>> {
  return act(z.object({ entity, year, rateBps: z.number().int().min(0).max(10_000) }), input, async (r, db) => {
    const { error } = await db
      .from("tax_settings")
      .upsert({ entity_id: await entityId(db, r.entity), year: r.year, set_aside_bps: r.rateBps }, { onConflict: "entity_id,year" });
    check("save rate", error);
    return { rateBps: r.rateBps };
  });
}

/** Record (or change) the estimated payment for one quarter. */
export async function savePayment(input: {
  entity: string;
  year: number;
  quarter: number;
  amountCents: number;
  paidOn: string;
}): Promise<ActionResult<Payment>> {
  const schema = z.object({ entity, year, quarter, amountCents: z.number().int().positive(), paidOn: z.iso.date() });
  return act(schema, input, async (p, db) => {
    const { error } = await db
      .from("tax_estimated_payments")
      .upsert(
        { entity_id: await entityId(db, p.entity), year: p.year, quarter: p.quarter, amount_cents: p.amountCents, paid_on: p.paidOn },
        { onConflict: "entity_id,year,quarter" },
      );
    check("save payment", error);
    return { quarter: p.quarter as Quarter, amountCents: p.amountCents, paidOn: p.paidOn };
  });
}

/** Remove a recorded payment. The page asks first; so must any other caller. */
export async function removePayment(input: { entity: string; year: number; quarter: number }): Promise<WithActivity<ActionResult<null>>> {
  let used: SupabaseClient | undefined;
  const result = await act(z.object({ entity, year, quarter }), input, async (p, db) => {
    const { error } = await (used = db)
      .from("tax_estimated_payments")
      .delete()
      .eq("entity_id", await entityId(db, p.entity))
      .eq("year", p.year)
      .eq("quarter", p.quarter);
    check("remove payment", error);
    return null;
  });
  return withActivity(result, used);
}

const LINE_TX_LIMIT = 500;

/** The expense transactions on one Schedule C line for an entity and year, newest first. */
export async function lineTransactions(input: {
  entity: string;
  year: number;
  taxLineId: string;
}): Promise<ActionResult<{ rows: LineTx[]; truncated: boolean }>> {
  return act(z.object({ entity, year, taxLineId: id }), input, async (q, db) => {
    const { data, error, count } = await db
      .from("reports_flow")
      .select("id, posted_on, payer, cents", { count: "exact" })
      .eq("entity_slug", q.entity)
      .eq("kind", "expense")
      .eq("tax_line_id", q.taxLineId)
      .gte("posted_on", `${q.year}-01-01`)
      .lte("posted_on", `${q.year}-12-31`)
      .order("posted_on", { ascending: false })
      .order("id")
      .limit(LINE_TX_LIMIT);
    check("line transactions", error);
    const rows = (data ?? []).map((r) => ({ id: r.id as string, postedOn: r.posted_on as string, payer: r.payer as string, cents: Number(r.cents) }));
    return { rows, truncated: (count ?? rows.length) > rows.length };
  });
}

/**
 * Record a file the browser already put in the tax-docs bucket. The path must be
 * `<entity>/<year>/<file>`, so one entity's upload cannot sit under another's folder.
 */
export async function registerDocument(input: {
  entity: string;
  year: number;
  kind: string;
  payer: string | null;
  name: string;
  storagePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
}): Promise<ActionResult<TaxDoc>> {
  const schema = z.object({
    entity,
    year,
    kind: z.enum(["w9", "1099", "other"]),
    payer: z.string().trim().min(1).max(200).nullable(),
    name: z.string().trim().min(1).max(200),
    storagePath: z.string().min(1).max(500),
    mimeType: z.string().max(100).nullable(),
    sizeBytes: z.number().int().min(0).nullable(),
  });
  return act(schema, input, async (d, db) => {
    if (!d.storagePath.startsWith(`${d.entity}/${d.year}/`) || d.storagePath.includes("..")) {
      throw new ActionError("invalid_input", "That file is in the wrong folder");
    }
    const { data, error } = await db
      .from("tax_documents")
      .insert({
        entity_id: await entityId(db, d.entity),
        year: d.year,
        kind: d.kind,
        name: d.name,
        payer: d.payer,
        storage_path: d.storagePath,
        mime_type: d.mimeType,
        size_bytes: d.sizeBytes,
      })
      .select("id, created_at")
      .single();
    check("add document", error);
    return { id: data!.id as string, kind: d.kind as DocKind, name: d.name, payer: d.payer, sizeBytes: d.sizeBytes, addedOn: String(data!.created_at).slice(0, 10) };
  });
}

async function pathOf(db: SupabaseClient, docId: string): Promise<string> {
  const { data, error } = await db.from("tax_documents").select("storage_path").eq("id", docId).limit(1);
  check("find document", error);
  if (!data?.[0]) throw new ActionError("not_found", "That document is gone");
  return data[0].storage_path as string;
}

/** A link to the file that works for one minute. */
export async function documentUrl(input: { id: string }): Promise<ActionResult<{ url: string }>> {
  return act(z.object({ id }), input, async (d, db) => {
    const { data, error } = await db.storage.from(BUCKET).createSignedUrl(await pathOf(db, d.id), 60);
    if (error || !data) throw new Error(`document url: ${error?.message ?? "no url"}`);
    return { url: data.signedUrl };
  });
}

/**
 * Delete a document. Its file goes to the trash for 30 days (undo puts it back; the daily prune
 * removes it). The page asks first; so must any other caller.
 */
export async function removeDocument(input: { id: string }): Promise<WithActivity<ActionResult<null>>> {
  let used: SupabaseClient | undefined;
  const result = await act(z.object({ id }), input, async (d, db) => {
    used = db;
    const path = await pathOf(db, d.id);
    const { error } = await db.from("tax_documents").delete().eq("id", d.id);
    check("remove document", error);
    // The row is gone first: a failed file move leaves a private orphan, never a dead row.
    await trashFile(db, BUCKET, path, activityIdOf(db));
    return null;
  });
  return withActivity(result, used);
}
