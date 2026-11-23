import { z } from "zod";
import * as taxes from "@/app/(app)/taxes/actions";
import { loadTaxes } from "@/app/(app)/taxes/data";
import { todayIn } from "@/lib/planning/dates";
import { day, defineTool, unwrap, uuid, type ToolCtx, type ToolDef } from "./registry";
import { namedDelete, q, rowOf } from "./tools-confirm";

/**
 * Taxes: the set-aside rate, estimated payments, documents and Schedule C lines, through the same
 * typed actions the Taxes page calls. Hydra stores what the owner types; it does not file taxes.
 * Uploading a document and opening its file stay in the browser.
 */

const entity = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "an entity slug");
const year = z.int().min(2000).max(2100);
const quarter = z.int().min(1).max(4);
const which = { entity, year };

async function current(ctx: ToolCtx, e: z.output<typeof entity>, y: number) {
  return loadTaxes(ctx.db, e, y, todayIn(ctx.now(), await ctx.timeZone()));
}

export const TAX_TOOLS: ToolDef[] = [
  defineTool({
    name: "get_taxes",
    description: "Taxes for one entity (personal, ugc, ugm or another business slug from get_settings) and year: income, Schedule C lines, set-aside rate, quarterly payments, documents.",
    group: "hydra",
    kind: "read",
    input: z.object(which),
    run: async (ctx, { entity: e, year: y }) => ({ data: await current(ctx, e, y), summary: `Read ${y} taxes` }),
  }),
  defineTool({
    name: "tax_line_transactions",
    description: "The expense transactions on one Schedule C line for a business and year, newest first.",
    group: "hydra",
    kind: "read",
    input: z.object({ ...which, taxLineId: uuid }),
    run: async (_ctx, input) => ({ data: unwrap(await taxes.lineTransactions(input)), summary: "Read a tax line's transactions" }),
  }),
  defineTool({
    name: "set_tax_rate",
    description: "Set the tax set-aside rate in basis points (2500 = 25%) for a business and year.",
    group: "hydra",
    kind: "write",
    input: z.object({ ...which, rateBps: z.int().min(0).max(10_000) }),
    run: async (ctx, input) => {
      const before = (await current(ctx, input.entity, input.year)).rateBps;
      const r = unwrap(await taxes.saveRate(input));
      return { data: r, summary: `Set the ${input.year} set-aside to ${input.rateBps / 100}%`, inverse: { tool: "set_tax_rate", input: { ...input, rateBps: before } } };
    },
  }),
  defineTool({
    name: "save_tax_payment",
    description: "Record, change or mark paid one quarter's estimated tax payment (cents, paid on YYYY-MM-DD).",
    group: "hydra",
    kind: "write",
    input: z.object({ ...which, quarter, amountCents: z.int().positive().max(1e13), paidOn: day }),
    run: async (ctx, input) => {
      const before = (await current(ctx, input.entity, input.year)).payments.find((p) => p.quarter === input.quarter);
      const r = unwrap(await taxes.savePayment(input));
      const key = { entity: input.entity, year: input.year, quarter: input.quarter };
      return {
        data: r,
        summary: `Recorded Q${input.quarter} ${input.year} payment`,
        inverse: before ? { tool: "save_tax_payment", input: { ...key, amountCents: before.amountCents, paidOn: before.paidOn } } : { tool: "delete_tax_payment", input: key },
      };
    },
  }),
  defineTool({
    name: "delete_tax_payment",
    description: "Delete one quarter's recorded estimated tax payment.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: (i) => `Delete the Q${i.quarter} ${i.year} tax payment`,
    input: z.object({ ...which, quarter }),
    run: async (ctx, input) => {
      const before = (await current(ctx, input.entity, input.year)).payments.find((p) => p.quarter === input.quarter);
      unwrap(await taxes.removePayment(input));
      return {
        data: { deleted: before ?? null },
        summary: `Deleted Q${input.quarter} ${input.year} payment`,
        inverse: before ? { tool: "save_tax_payment", input: { ...input, amountCents: before.amountCents, paidOn: before.paidOn } } : null,
      };
    },
  }),
  defineTool({
    name: "delete_tax_document",
    description: "Delete a tax document (W-9, 1099) and its file.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Delete this tax document and its file",
    gate: namedDelete("Delete this tax document and its file", async (ctx, { id }: { id: string }) => {
      const doc = await rowOf<{ name: string; year: number }>(ctx, "tax_documents", id, "name, year");
      return doc && `Delete the ${doc.year} tax document ${q(doc.name)} and its file`;
    }),
    input: z.object({ id: uuid }),
    run: async (_ctx, input) => ({ data: unwrap(await taxes.removeDocument(input)), summary: "Deleted a tax document", inverse: null }),
  }),
];
