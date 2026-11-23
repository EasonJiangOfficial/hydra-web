import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { TAX_SHAPES, type Entity } from "./model";

/** The one entity read: Personal first, then businesses in the order they were added. Pass the owner's client. */
export async function listEntities(db: SupabaseClient): Promise<Entity[]> {
  const { data, error } = await db.from("entities").select("id, slug, name, kind, tax_shape, status, closed_on").order("created_at").order("slug");
  if (error) throw new Error(`entities: ${error.message}`);
  const rows = z
    .array(
      z.object({
        id: z.string(),
        slug: z.string(),
        name: z.string(),
        kind: z.enum(["personal", "business"]),
        tax_shape: z.enum(TAX_SHAPES).nullable(),
        status: z.enum(["active", "closed"]),
        closed_on: z.string().nullable(),
      }),
    )
    .parse(data ?? []);
  return rows
    .map((r): Entity => ({ id: r.id, slug: r.slug, name: r.name, kind: r.kind, taxShape: r.tax_shape, status: r.status, closedOn: r.closed_on }))
    .sort((a, b) => Number(b.kind === "personal") - Number(a.kind === "personal"));
}

/** Per entity: whether anything uses it (then it can only be closed) and how many accounts point at it. */
export async function entityUse(db: SupabaseClient): Promise<Record<string, { inUse: boolean; accounts: number }>> {
  const { data, error } = await db.rpc("entities_in_use");
  if (error) throw new Error(`entities_in_use: ${error.message}`);
  const rows = z.array(z.object({ id: z.string(), in_use: z.boolean(), accounts: z.number().int() })).parse(data ?? []);
  return Object.fromEntries(rows.map((r) => [r.id, { inUse: r.in_use, accounts: r.accounts }]));
}
