import { z } from "zod";
import {
  createDealSchema,
  dayKeySchema,
  dealRowToInput,
  type ActionResult,
  type DealDbRow,
} from "@/lib/ugc/schemas";
import * as w from "@/lib/ugc/writes";

/**
 * Deal templates: the "already created" deals the owner can add (public.deal_templates, 0011).
 * A template holds a brand, a logo and the whole pay structure; adding one makes a new deal that
 * copies all of it. Plain module (no "use server"): actions.ts and queries.ts wrap these.
 * Templates are written only by scripts/import-ripple, so there is no template write here.
 */

export const LOGO_BUCKET = "deal-logos";

/** The `public.deal_templates` row: a deal's pay columns without entity, status and dates. */
export type TemplateDbRow = Omit<DealDbRow, "entity_id" | "status" | "start_date" | "end_date"> & {
  archived: boolean;
};

export const createDealFromTemplateSchema = z.object({
  templateId: z.uuid(),
  startDate: dayKeySchema,
  endDate: dayKeySchema.nullable().optional(),
  /** Rename the new deal; default is the template's brand name. */
  brandName: z.string().trim().min(1).max(200).optional(),
});

/** Templates by brand name. Archived ones are hidden unless `includeArchived`. */
export async function readTemplates(
  db: w.Db,
  opts: { includeArchived?: boolean } = {},
): Promise<TemplateDbRow[]> {
  let q = db.from("deal_templates").select("*");
  if (!opts.includeArchived) q = q.eq("archived", false);
  const { data, error } = await q.order("brand_name", { ascending: true }).order("id");
  if (error) throw new Error(`UGC read failed: ${error.message}`);
  return (data ?? []) as TemplateDbRow[];
}

/** Copy the template's logo object so the deal owns its own file. Returns the new path. */
async function copyLogo(db: w.Db, from: string): Promise<ActionResult<string>> {
  const name = from.split("/").pop() || "logo";
  const to = `deals/${crypto.randomUUID()}/${name}`;
  const { error } = await db.storage.from(LOGO_BUCKET).copy(from, to);
  return error ? w.fail("db_error", `Could not copy the logo: ${error.message}`) : w.ok(to);
}

/**
 * Add a deal from a template: copies the pay structure and the logo, takes the dates from the
 * input, then calls the normal createDeal (so the pay structure is validated like any deal).
 * Nothing is created when the logo copy or the deal write fails.
 */
export async function createDealFromTemplate(
  db: w.Db,
  input: z.output<typeof createDealFromTemplateSchema>,
): Promise<ActionResult<DealDbRow>> {
  const found = await db.from("deal_templates").select("*").eq("id", input.templateId).maybeSingle();
  if (found.error) return w.dbFail(found.error);
  if (!found.data) return w.fail("not_found", "No such template");
  const t = found.data as TemplateDbRow;
  if (t.archived) return w.fail("rejected", "This template is archived");

  const fields = dealRowToInput({
    ...t,
    entity_id: "",
    status: "active",
    start_date: input.startDate,
    end_date: input.endDate ?? null,
  });
  if (input.brandName) fields.brandName = input.brandName;
  let copied: string | null = null;
  if (t.logo_path) {
    const logo = await copyLogo(db, t.logo_path);
    if (!logo.ok) return logo;
    copied = fields.logoPath = logo.data;
  }

  const result = await w.createDeal(db, createDealSchema.parse(fields));
  // A failed write, a retry or a raced double submit leaves the copy unused: the deal made first owns its own.
  if (copied && (!result.ok || result.data.logo_path !== copied)) {
    await db.storage.from(LOGO_BUCKET).remove([copied]);
  }
  return result;
}
