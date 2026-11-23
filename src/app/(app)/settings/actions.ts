"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { withActivity, type WithActivity } from "@/lib/activity/request";
import { TAX_SHAPES, filesScheduleC, slugFor, type Entity, type TaxShape } from "@/lib/entities/model";
import { entityUse, listEntities } from "@/lib/entities/queries";
import { createServerClient } from "@/lib/supabase/server";

/**
 * Businesses (owner, 2026-11-22): add, rename, change the tax type, close, reopen, delete. Owner checked
 * first, input validated, written as the owner (RLS and 0170's rules apply), each write one Activity entry
 * the undo bar can reverse. Close keeps history; delete only when nothing uses the business. Personal is
 * never closed or deleted. The page and the Hydra Agent call these.
 */

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

class ActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const IN_USE = "In use: close it instead";

async function act<S extends z.ZodType, T>(
  schema: S,
  input: unknown,
  run: (input: z.output<S>, db: SupabaseClient) => Promise<T>,
): Promise<{ result: ActionResult<T>; db?: SupabaseClient }> {
  const fail = (code: string, message: string) => ({ result: { ok: false, error: { code, message } } as ActionResult<T> });
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("invalid_input", z.prettifyError(parsed.error));
  try {
    const db = await createServerClient();
    const { data: owner, error } = await db.rpc("is_owner");
    if (error || owner !== true) return fail("not_owner", "Sign in as the owner");
    return { result: { ok: true, data: await run(parsed.data, db) }, db };
  } catch (e) {
    if (e instanceof ActionError) return fail(e.code, e.message);
    console.error(`[settings] ${(e as Error).message}`);
    return fail("internal", "Something went wrong");
  }
}

function check(what: string, error: { message: string; code?: string } | null) {
  if (!error) return;
  if (error.code === "23503") throw new ActionError("in_use", IN_USE);
  if (error.code === "23505") throw new ActionError("conflict", "That name is taken");
  if (error.code === "23514") throw new ActionError("invalid_input", error.message.replace(/^entities: /, ""));
  throw new Error(`${what}: ${error.message}`);
}

const id = z.guid();
const name = z.string().trim().min(1, "Type a name").max(60, "At most 60 characters");
const taxShape = z.enum(TAX_SHAPES);

async function find(db: SupabaseClient, entityId: string): Promise<Entity> {
  const e = (await listEntities(db)).find((x) => x.id === entityId);
  if (!e) throw new ActionError("not_found", "No such business");
  return e;
}

async function setStatus(db: SupabaseClient, entityId: string, status: "active" | "closed"): Promise<Entity> {
  const e = await find(db, entityId);
  if (e.kind === "personal") throw new ActionError("invalid_input", "Personal cannot be closed");
  const { error } = await db.from("entities").update({ status }).eq("id", entityId);
  check(`${status === "closed" ? "close" : "reopen"} business`, error);
  return find(db, entityId);
}

/** Add a business. Its slug comes from the name. Schedule C types start with UGC's category-to-line map. */
export async function addBusiness(input: { name: string; taxShape: TaxShape }): Promise<WithActivity<ActionResult<Entity>>> {
  const { result, db } = await act(z.object({ name, taxShape }), input, async (b, db) => {
    const all = await listEntities(db);
    if (all.some((e) => e.name.trim().toLowerCase() === b.name.toLowerCase())) throw new ActionError("conflict", "That name is taken");
    const slug = slugFor(b.name, all.map((e) => e.slug));
    const { data, error } = await db.from("entities").insert({ slug, name: b.name, kind: "business", tax_shape: b.taxShape }).select("id").single();
    check("add business", error);
    const newId = (data as { id: string }).id;
    const ugc = all.find((e) => e.slug === "ugc");
    if (filesScheduleC(b.taxShape) && ugc) {
      try {
        const { data: map, error: readError } = await db.from("category_tax_lines").select("category_id, tax_line_id").eq("entity_id", ugc.id);
        check("read the UGC Schedule C map", readError);
        if (map?.length) {
          const { error: copyError } = await db.from("category_tax_lines").insert(map.map((m) => ({ ...m, entity_id: newId })));
          check("copy the Schedule C map", copyError);
        }
      } catch (e) {
        // ponytail: compensating delete, not one transaction; an add_business RPC if this ever half-fails in practice.
        // No half business: take the new row back (its copied map rows go with it, 0170), so a retry can use the name.
        const { error: undoError } = await db.from("entities").delete().eq("id", newId);
        if (undoError) console.error(`[settings] remove the half-added business: ${undoError.message}`);
        throw e;
      }
    }
    return find(db, newId);
  });
  return withActivity(result, db);
}

/** Rename a business or change its tax type. Personal takes a new name only. The slug never changes. */
export async function updateBusiness(input: { id: string; name?: string; taxShape?: TaxShape }): Promise<WithActivity<ActionResult<Entity>>> {
  const schema = z.object({ id, name: name.optional(), taxShape: taxShape.optional() }).refine((p) => p.name !== undefined || p.taxShape !== undefined, "Nothing to change");
  const { result, db } = await act(schema, input, async (p, db) => {
    const before = await find(db, p.id);
    if (before.kind === "personal" && p.taxShape !== undefined) throw new ActionError("invalid_input", "Personal has no tax type");
    if (p.name !== undefined && (await listEntities(db)).some((e) => e.id !== p.id && e.name.trim().toLowerCase() === p.name!.toLowerCase()))
      throw new ActionError("conflict", "That name is taken");
    const patch: Record<string, string> = {};
    if (p.name !== undefined) patch.name = p.name;
    if (p.taxShape !== undefined) patch.tax_shape = p.taxShape;
    const { error } = await db.from("entities").update(patch).eq("id", p.id);
    check("update business", error);
    return find(db, p.id);
  });
  return withActivity(result, db);
}

/** Close: hidden from the switch and pickers; its money stays in reports and Taxes. */
export async function closeBusiness(input: { id: string }): Promise<WithActivity<ActionResult<Entity>>> {
  const { result, db } = await act(z.object({ id }), input, (p, db) => setStatus(db, p.id, "closed"));
  return withActivity(result, db);
}

export async function reopenBusiness(input: { id: string }): Promise<WithActivity<ActionResult<Entity>>> {
  const { result, db } = await act(z.object({ id }), input, (p, db) => setStatus(db, p.id, "active"));
  return withActivity(result, db);
}

/** Delete a business nothing uses. The page and the agent ask first. In use: close it instead. */
export async function deleteBusiness(input: { id: string }): Promise<WithActivity<ActionResult<null>>> {
  const { result, db } = await act(z.object({ id }), input, async (p, db) => {
    const e = await find(db, p.id);
    if (e.kind === "personal") throw new ActionError("invalid_input", "Personal cannot be deleted");
    if ((await entityUse(db))[p.id]?.inUse) throw new ActionError("in_use", IN_USE);
    const { error } = await db.from("entities").delete().eq("id", p.id);
    check("delete business", error);
    return null;
  });
  return withActivity(result, db);
}
