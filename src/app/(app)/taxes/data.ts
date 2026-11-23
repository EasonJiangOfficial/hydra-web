import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { entityUse, listEntities } from "@/lib/entities/queries";
import { monthlyTrend, taxLineTotals } from "@/lib/reports/queries";
import { listCategories, listCategoryTaxLines } from "@/lib/rules/queries";
import {
  DEFAULT_ENTITY,
  DEFAULT_RATE_BPS,
  isEntitySlug,
  pickSection,
  taxSections,
  yearChoices,
  type TaxSection,
  type DocKind,
  type EntitySlug,
  type Payment,
  type Quarter,
  type TaxDoc,
  type TaxesData,
} from "./model";

/** Taxes page reads: one entity, one calendar year. Pass the signed-in client (RLS keeps it to the owner). */

/** `?entity=` and `?year=` from the URL; anything unknown falls back to UGC and this year. */
export function parseParams(
  params: Record<string, string | string[] | undefined>,
  today: string,
): { entity: EntitySlug; year: number } {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const entity = one(params.entity);
  const year = Number(one(params.year));
  return {
    entity: isEntitySlug(entity) ? entity : DEFAULT_ENTITY,
    year: yearChoices(today).includes(year) ? year : Number(today.slice(0, 4)),
  };
}

const cents = z.number().int();
const payerRows = z.array(z.object({ payer: z.string(), cents }));
const summaryRows = z.array(z.object({ income_cents: cents }));
const paymentRows = z.array(
  z.object({ quarter: z.number().int().min(1).max(4), amount_cents: cents, paid_on: z.iso.date() }),
);
const docRows = z.array(
  z.object({
    id: z.guid(),
    kind: z.enum(["w9", "1099", "other"]),
    name: z.string(),
    payer: z.string().nullable(),
    size_bytes: z.number().nullable(),
    created_at: z.string(),
  }),
);

function ok<T>(what: string, r: { data: T | null; error: { message: string } | null }): T {
  if (r.error || r.data === null) throw new Error(`taxes: ${what}: ${r.error?.message ?? "no data"}`);
  return r.data;
}

/** The report functions take the entity slug as their scope, so the closed LLC works too. */
async function rpc<T extends z.ZodType>(db: SupabaseClient, fn: string, slug: string, year: number, row: T): Promise<z.output<T>> {
  const { data, error } = await db.rpc(fn, { p_scope: slug, p_from: `${year}-01-01`, p_to: `${year}-12-31` });
  if (error) throw new Error(`${fn}: ${error.message}`);
  const parsed = row.safeParse(data ?? []);
  if (!parsed.success) throw new Error(`${fn}: unexpected rows`);
  return parsed.data;
}

export async function entityId(db: SupabaseClient, slug: EntitySlug): Promise<string> {
  const rows = ok("entities", await db.from("entities").select("id").eq("slug", slug).limit(1));
  if (!rows[0]) throw new Error(`taxes: no entity "${slug}"`);
  return rows[0].id as string;
}

/** The Taxes switch: active businesses, Personal, and closed businesses that still have data. */
export async function loadSections(db: SupabaseClient): Promise<TaxSection[]> {
  const [entities, use] = await Promise.all([listEntities(db), entityUse(db)]);
  return taxSections(entities, (id) => use[id]?.inUse ?? false);
}

/** One section and year. An entity the switch does not offer falls back to UGC (or the first section). */
export async function loadTaxes(db: SupabaseClient, asked: EntitySlug, year: number, today: string): Promise<TaxesData> {
  const sections = await loadSections(db);
  const section = pickSection(sections, asked);
  const entity = section.slug;
  const id = await entityId(db, entity);
  const range = { from: `${year}-01-01`, to: `${year}-12-31` };
  const [totals, payers, summary, mapped, categories, settings, payments, documents, trend] = await Promise.all([
    taxLineTotals(db, "all", range),
    rpc(db, "reports_income_by_payer", entity, year, payerRows),
    rpc(db, "reports_income_summary", entity, year, summaryRows),
    listCategoryTaxLines(db),
    listCategories(db, { includeArchived: true }),
    db.from("tax_settings").select("set_aside_bps").eq("entity_id", id).eq("year", year).limit(1),
    db.from("tax_estimated_payments").select("quarter, amount_cents, paid_on").eq("entity_id", id).eq("year", year).order("quarter"),
    db.from("tax_documents").select("id, kind, name, payer, size_bytes, created_at").eq("entity_id", id).eq("year", year).order("created_at", { ascending: false }),
    monthlyTrend(db, entity, range),
  ]);

  const names = new Map(categories.map((c) => [c.id, c.name]));
  const fromCategories = new Map<string, string[]>();
  for (const m of mapped.filter((m) => m.entity_id === id)) {
    const name = names.get(m.category_id);
    if (name) fromCategories.set(m.tax_line_id, [...(fromCategories.get(m.tax_line_id) ?? []), name]);
  }

  const rate = ok("settings", settings)[0]?.set_aside_bps as number | undefined;
  return {
    entity,
    year,
    today,
    entityClosed: section.closed,
    sections,
    treatment: section.treatment,
    incomeCents: summary[0]?.income_cents ?? 0,
    spendingCents: trend.months.reduce((a, m) => a + m.spendingCents, 0),
    payers: payers.map((p) => ({ name: p.payer, cents: p.cents })),
    lines: totals.rows
      .filter((r) => r.entitySlug === entity && r.year === year)
      .map((r) => ({
        id: r.taxLineId,
        code: r.code,
        name: r.name,
        cents: r.cents,
        count: r.count,
        categories: (fromCategories.get(r.taxLineId) ?? []).sort(),
      })),
    rateBps: rate ?? DEFAULT_RATE_BPS,
    payments: paymentRows.parse(ok("payments", payments)).map(
      (p): Payment => ({ quarter: p.quarter as Quarter, amountCents: p.amount_cents, paidOn: p.paid_on }),
    ),
    documents: docRows.parse(ok("documents", documents)).map(
      (d): TaxDoc => ({ id: d.id, kind: d.kind as DocKind, name: d.name, payer: d.payer, sizeBytes: d.size_bytes, addedOn: d.created_at.slice(0, 10) }),
    ),
  };
}
