"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { withActivity, type WithActivity } from "@/lib/activity/request";
import { addDays } from "@/lib/planning/dates";
import { createServerClient } from "@/lib/supabase/server";
import {
  applyRules as runRules,
  detectAndSaveRecurring,
  loadRules,
  ownerToday,
  pairTransfers as runPairing,
  TARGET_COLUMNS,
} from "./engine";
import { matchCondition, patchFor, suggestRule } from "./match";
import { actionsSchema, conditionsSchema, type Action, type Condition, type Rule, type RulePatch, type RuleTarget } from "./model";
import type { CategoryRow } from "./queries";

/**
 * Money-rule writes as typed actions: owner checked first, input validated, then written as the
 * owner (RLS applies). The pages and the Hydra Agent (U13) call exactly these. Expected failures
 * come back as `{ ok: false, error }`; edits return what they replaced (`before`) so a caller can undo.
 */

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

type RuleRow = Rule & { created_at: string; updated_at: string };
type DbError = { code?: string; message: string };

class ActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const DB_MESSAGES: [RegExp, string, string][] = [
  [/categories: two levels only/, "invalid_input", "A subcategory cannot have subcategories"],
  [/categories: (parent differs|bad parent)/, "invalid_input", "A subcategory needs a top-level parent of the same kind and business"],
  [/categories: same category/, "invalid_input", "Pick two different categories"],
  [/categories: kinds differ/, "invalid_input", "Only categories of the same kind can be merged"],
  [/categories: unknown category/, "not_found", "That category is gone"],
  [/rules: changed/, "conflict", "The rules changed. Reload and try again"],
];

function dbError(what: string, error: DbError): Error {
  const hit = DB_MESSAGES.find(([re]) => re.test(error.message));
  if (hit) return new ActionError(hit[1], hit[2]);
  if (error.code === "23505") return new ActionError("conflict", `${what}: that already exists`);
  if (error.code === "23503") return new ActionError("in_use", `${what}: it is in use, or it points at something that is gone`);
  return new Error(`${what}: ${error.message}`);
}

/** The data of a query, or a readable error. `null` data is not_found. */
async function must<T>(what: string, query: PromiseLike<{ data: T | null; error: DbError | null }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw dbError(what, error);
  if (data === null) throw new ActionError("not_found", `${what}: not found`);
  return data;
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
    console.error(`[rules] ${(e as Error).message}`);
    return fail("internal", "Something went wrong");
  }
}

const id = z.guid();
const day = z.iso.date();
const RULE_COLUMNS = "id, position, conditions, actions, enabled, created_at, updated_at";
const CATEGORY_COLUMNS = "id, name, parent_id, kind, entity_id, color, archived";
const definedOnly = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** A rule may only point at rows that exist. */
async function checkRefs(db: SupabaseClient, actions: readonly Action[]) {
  for (const a of actions) {
    const [table, ref] =
      a.type === "set_category" ? ["categories", a.categoryId]
      : a.type === "set_entity" ? ["entities", a.entityId]
      : a.type === "set_tax_line" ? ["tax_lines", a.taxLineId]
      : a.type === "mark_recurring" ? ["recurring", a.recurringId]
      : [null, null];
    if (table) await must(`${a.type} target`, db.from(table).select("id").eq("id", ref).maybeSingle());
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Add a rule. It runs last unless `first`. `applyFrom` (YYYY-MM-DD) also runs every rule over the
 * rows posted on or after that day (rows categorized by hand are never touched).
 */
export async function createRule(input: {
  conditions: Condition[];
  actions: Action[];
  enabled?: boolean;
  first?: boolean;
  applyFrom?: string;
}): Promise<ActionResult<{ rule: RuleRow; applied: { checked: number; changed: number } | null }>> {
  const schema = z.object({
    conditions: conditionsSchema,
    actions: actionsSchema,
    enabled: z.boolean().default(true),
    first: z.boolean().default(false),
    applyFrom: day.optional(),
  });
  return act(schema, input, async (r, db) => {
    await checkRefs(db, r.actions);
    const { data: edge, error } = await db.from("rules").select("position").order("position", { ascending: r.first }).limit(1).maybeSingle();
    if (error) throw dbError("rule order", error);
    const position = edge ? (edge.position as number) + (r.first ? -1 : 1) : 0;
    const rule = (await must(
      "add rule",
      db.from("rules").insert({ position, conditions: r.conditions, actions: r.actions, enabled: r.enabled }).select(RULE_COLUMNS).single(),
    )) as RuleRow;
    return { rule, applied: r.applyFrom ? await runRules(db, { from: r.applyFrom }) : null };
  });
}

/** Change a rule's conditions, actions or on/off. `applyFrom` as in createRule. */
export async function updateRule(input: {
  id: string;
  conditions?: Condition[];
  actions?: Action[];
  enabled?: boolean;
  applyFrom?: string;
}): Promise<ActionResult<{ rule: RuleRow; before: RuleRow; applied: { checked: number; changed: number } | null }>> {
  const schema = z.object({
    id,
    conditions: conditionsSchema.optional(),
    actions: actionsSchema.optional(),
    enabled: z.boolean().optional(),
    applyFrom: day.optional(),
  });
  return act(schema, input, async (r, db) => {
    if (r.actions) await checkRefs(db, r.actions);
    const before = (await must("rule", db.from("rules").select(RULE_COLUMNS).eq("id", r.id).maybeSingle())) as RuleRow;
    const patch = definedOnly({ conditions: r.conditions, actions: r.actions, enabled: r.enabled });
    const rule = Object.keys(patch).length
      ? ((await must("edit rule", db.from("rules").update(patch).eq("id", r.id).select(RULE_COLUMNS).single())) as RuleRow)
      : before;
    return { rule, before, applied: r.applyFrom ? await runRules(db, { from: r.applyFrom }) : null };
  });
}

/** Delete a rule. Rows it categorized keep their category. */
export async function deleteRule(input: { id: string }): Promise<WithActivity<ActionResult<{ before: RuleRow }>>> {
  let used: SupabaseClient | undefined;
  const result = await act(z.object({ id }), input, async ({ id: ruleId }, db) => ({
    before: (await must("delete rule", (used = db).from("rules").delete().eq("id", ruleId).select(RULE_COLUMNS).maybeSingle())) as RuleRow,
  }));
  return withActivity(result, used);
}

/** Put the rules in this order (every rule id, first runs first). */
export async function reorderRules(input: { ids: string[] }): Promise<ActionResult<{ ids: string[] }>> {
  return act(z.object({ ids: z.array(id).max(1000) }), input, async ({ ids }, db) => {
    const { error } = await db.rpc("rules_reorder", { p_ids: ids });
    if (error) throw dbError("reorder rules", error);
    return { ids };
  });
}

export interface PreviewRow {
  id: string;
  posted_on: string;
  name: string;
  merchant: string | null;
  amount_cents: number;
  category_id: string | null;
  /** Categorized by hand: the rule will not touch it. */
  manual: boolean;
  /** What the rule would change; null when nothing. */
  patch: RulePatch | null;
}

/** Before saving: the recent rows (default 90 days, newest 1,000) this rule matches, and what it would change. */
export async function previewRule(input: {
  conditions: Condition[];
  actions: Action[];
  days?: number;
}): Promise<ActionResult<{ checked: number; matched: number; rows: PreviewRow[] }>> {
  const schema = z.object({ conditions: conditionsSchema, actions: actionsSchema, days: z.int().min(1).max(3660).default(90) });
  return act(schema, input, async (r, db) => {
    const since = addDays(await ownerToday(db), -r.days);
    const rows = (await must(
      "recent rows",
      db
        .from("transactions")
        .select(TARGET_COLUMNS)
        .gte("posted_on", since)
        .order("posted_on", { ascending: false })
        .order("id", { ascending: false })
        .limit(1000),
    )) as unknown as (RuleTarget & { posted_on: string })[];
    const matched = rows.filter((t) => r.conditions.every((c) => matchCondition(c, t)));
    return {
      checked: rows.length,
      matched: matched.length,
      rows: matched.slice(0, 200).map((t) => ({
        id: t.id,
        posted_on: t.posted_on,
        name: t.name,
        merchant: t.merchant,
        amount_cents: t.amount_cents,
        category_id: t.category_id,
        manual: t.category_source === "manual",
        patch: t.category_source === "manual" ? null : patchFor(r.actions, t),
      })),
    };
  });
}

/** Run every rule over one row, or over the rows posted between `from` and `to`. Hand-categorized rows are skipped. */
export async function applyRules(
  input: { transactionId: string } | { from?: string; to?: string },
): Promise<ActionResult<{ checked: number; changed: number }>> {
  const schema = z.union([
    z.object({ transactionId: id }),
    // Strict: a bad transactionId must not fall through to "every row".
    z.strictObject({ from: day.optional(), to: day.optional() }).refine((s) => !s.from || !s.to || s.from <= s.to, "from must be on or before to"),
  ]);
  return act(schema, input, async (s, db) => runRules(db, "transactionId" in s ? { ids: [s.transactionId] } : s));
}

/**
 * The owner picks a category (null clears it) and, optionally, the business. Rules never change
 * this row again. `suggestion` is the rule to offer ("make a rule?"), or null when the rules
 * already give this row that category.
 */
export async function setTransactionCategory(input: {
  transactionId: string;
  categoryId: string | null;
  entityId?: string;
}): Promise<
  ActionResult<{
    transactionId: string;
    before: { category_id: string | null; category_source: string; entity_id: string };
    suggestion: { conditions: Condition[]; actions: Action[] } | null;
  }>
> {
  const schema = z.object({ transactionId: id, categoryId: id.nullable(), entityId: id.optional() });
  return act(schema, input, async (r, db) => {
    const row = (await must("transaction", db.from("transactions").select(TARGET_COLUMNS).eq("id", r.transactionId).maybeSingle())) as unknown as RuleTarget;
    await must(
      "set category",
      db
        .from("transactions")
        .update(definedOnly({ category_id: r.categoryId, category_source: "manual", entity_id: r.entityId, entity_manual: r.entityId ? true : undefined }))
        .eq("id", r.transactionId)
        .select("id")
        .single(),
    );
    return {
      transactionId: r.transactionId,
      before: { category_id: row.category_id, category_source: row.category_source, entity_id: row.entity_id },
      suggestion: r.categoryId ? suggestRule(await loadRules(db), row, r.categoryId) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Transfers and card payments
// ---------------------------------------------------------------------------

/** Pair two rows by hand as one transfer or card payment: different accounts, opposite signs, both unpaired. */
export async function pairTransfers(input: { aId: string; bId: string }): Promise<ActionResult<{ paired: true }>> {
  return act(z.object({ aId: id, bId: id }), input, async ({ aId, bId }, db) => {
    const { data, error } = await db.rpc("ledger_pair_transfers", { p_pairs: [{ a: aId, b: bId }] });
    if (error) throw dbError("pair", error);
    if (data !== 1) throw new ActionError("rejected", "These two cannot be paired: same account, same sign, or one is already paired");
    return { paired: true as const };
  });
}

/** Undo a pair (or a rule's transfer mark). Both rows then count as income or spending again, and rules leave them alone. */
export async function unpairTransfer(input: { transactionId: string }): Promise<ActionResult<{ changed: number }>> {
  return act(z.object({ transactionId: id }), input, async ({ transactionId }, db) => {
    const { data, error } = await db.rpc("ledger_unpair_transfer", { p_id: transactionId });
    if (error) throw dbError("unpair", error);
    if (!data) throw new ActionError("not_found", "unpair: not found");
    return { changed: data as number };
  });
}

/** "Not a transfer" on a suggested pair (Needs review): it is not suggested again. Both rows keep counting. */
export async function rejectTransferSuggestion(input: { aId: string; bId: string }): Promise<ActionResult<{ rejected: true }>> {
  return act(z.object({ aId: id, bId: id }).refine((v) => v.aId !== v.bId), input, async ({ aId, bId }, db) => {
    const [a_id, b_id] = aId < bId ? [aId, bId] : [bId, aId];
    const { error } = await db.from("transfer_rejections").upsert({ a_id, b_id }, { onConflict: "a_id,b_id", ignoreDuplicates: true });
    if (error) throw dbError("not a transfer", error);
    return { rejected: true as const };
  });
}

/** Pair the card and loan payments (engine findClearPairs); a match between cash accounts is only suggested. */
export async function autoPairTransfers(
  input: { from?: string; to?: string; windowDays?: number } = {},
): Promise<ActionResult<{ paired: number }>> {
  const schema = z.object({ from: day.optional(), to: day.optional(), windowDays: z.int().min(0).max(30).optional() });
  return act(schema, input, async (s, db) => runPairing(db, s));
}

// ---------------------------------------------------------------------------
// Recurring
// ---------------------------------------------------------------------------

type RecurringStatus = "suggested" | "confirmed" | "dismissed";

async function setRecurringStatus(db: SupabaseClient, recurringId: string, status: RecurringStatus) {
  const before = (await must("recurring", db.from("recurring").select("status").eq("id", recurringId).maybeSingle())) as { status: RecurringStatus };
  await must("set recurring status", db.from("recurring").update({ status }).eq("id", recurringId).select("id").single());
  return before.status;
}

export async function confirmRecurring(input: { id: string }): Promise<ActionResult<{ before: RecurringStatus }>> {
  return act(z.object({ id }), input, async (r, db) => ({ before: await setRecurringStatus(db, r.id, "confirmed") }));
}

/** Dismiss a series: it is never suggested again, and its rows are unlinked from it. */
export async function dismissRecurring(input: { id: string }): Promise<ActionResult<{ before: RecurringStatus; unlinked: number }>> {
  return act(z.object({ id }), input, async (r, db) => {
    const before = await setRecurringStatus(db, r.id, "dismissed");
    const unlinked = (await must("unlink", db.from("transactions").update({ recurring_id: null }).eq("recurring_id", r.id).select("id"))) as unknown[];
    return { before, unlinked: unlinked.length };
  });
}

/** Look for recurring series now (the daily job does the same). */
export async function detectRecurringNow(): Promise<ActionResult<{ found: number; saved: number }>> {
  return act(z.undefined(), undefined, async (_, db) => detectAndSaveRecurring(db, await ownerToday(db)));
}

// ---------------------------------------------------------------------------
// Categories and tax lines
// ---------------------------------------------------------------------------

const categoryName = z.string().trim().min(1).max(80);
const kind = z.enum(["income", "expense", "transfer"]);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable();

export async function createCategory(input: {
  name: string;
  kind: "income" | "expense" | "transfer";
  entityId?: string | null;
  parentId?: string | null;
  color?: string | null;
}): Promise<ActionResult<{ category: CategoryRow }>> {
  const schema = z.object({ name: categoryName, kind, entityId: id.nullable().default(null), parentId: id.nullable().default(null), color: color.default(null) });
  return act(schema, input, async (c, db) => ({
    category: (await must(
      "add category",
      db.from("categories").insert({ name: c.name, kind: c.kind, entity_id: c.entityId, parent_id: c.parentId, color: c.color }).select(CATEGORY_COLUMNS).single(),
    )) as CategoryRow,
  }));
}

/** Rename, move, recolor, change kind or business, archive (archived categories leave the pickers; history stays). */
export async function updateCategory(input: {
  id: string;
  name?: string;
  kind?: "income" | "expense" | "transfer";
  entityId?: string | null;
  parentId?: string | null;
  color?: string | null;
  archived?: boolean;
}): Promise<ActionResult<{ category: CategoryRow; before: CategoryRow }>> {
  const schema = z.object({
    id,
    name: categoryName.optional(),
    kind: kind.optional(),
    entityId: id.nullable().optional(),
    parentId: id.nullable().optional(),
    color: color.optional(),
    archived: z.boolean().optional(),
  });
  return act(schema, input, async (c, db) => {
    const before = (await must("category", db.from("categories").select(CATEGORY_COLUMNS).eq("id", c.id).maybeSingle())) as CategoryRow;
    const patch = definedOnly({ name: c.name, kind: c.kind, entity_id: c.entityId, parent_id: c.parentId, color: c.color, archived: c.archived });
    if (!Object.keys(patch).length) throw new ActionError("invalid_input", "Nothing to change");
    const category = (await must("edit category", db.from("categories").update(patch).eq("id", c.id).select(CATEGORY_COLUMNS).single())) as CategoryRow;
    return { category, before };
  });
}

/** Delete an unused category. One with transactions, subcategories or rules is refused: merge or archive it. */
export async function deleteCategory(input: { id: string }): Promise<WithActivity<ActionResult<{ before: CategoryRow }>>> {
  let used: SupabaseClient | undefined;
  const result = await act(z.object({ id }), input, async ({ id: categoryId }, db) => {
    used = db;
    const rules = (await must(
      "rules using the category",
      db.from("rules").select("id").contains("actions", [{ type: "set_category", categoryId }]).limit(1),
    )) as unknown[];
    if (rules.length) throw new ActionError("in_use", "A rule sets this category. Change the rule, or merge the category");
    const { data, error } = await db.from("categories").delete().eq("id", categoryId).select(CATEGORY_COLUMNS).maybeSingle();
    if (error?.code === "23503") throw new ActionError("in_use", "This category is in use. Merge it or archive it");
    if (error) throw dbError("delete category", error);
    if (!data) throw new ActionError("not_found", "delete category: not found");
    return { before: data as CategoryRow };
  });
  return withActivity(result, used);
}

/** Move everything in `fromId` (transactions, subcategories, tax line maps, rules) into `intoId`, then delete `fromId`. */
export async function mergeCategories(input: { fromId: string; intoId: string }): Promise<ActionResult<{ moved: number }>> {
  return act(z.object({ fromId: id, intoId: id }), input, async ({ fromId, intoId }, db) => {
    const { data, error } = await db.rpc("categories_merge", { p_from: fromId, p_into: intoId });
    if (error) throw dbError("merge categories", error);
    return { moved: data as number };
  });
}

/** Map a category to one Schedule C line for one business (null removes the map). */
export async function mapCategoryTaxLine(input: {
  categoryId: string;
  entityId: string;
  taxLineId: string | null;
}): Promise<ActionResult<{ before: string | null }>> {
  return act(z.object({ categoryId: id, entityId: id, taxLineId: id.nullable() }), input, async (m, db) => {
    const current = (await must(
      "tax line map",
      db.from("category_tax_lines").select("tax_line_id").eq("category_id", m.categoryId).eq("entity_id", m.entityId),
    )) as { tax_line_id: string }[];
    const before = current[0]?.tax_line_id ?? null;
    if (m.taxLineId === null) {
      await must(
        "unmap tax line",
        db.from("category_tax_lines").delete().eq("category_id", m.categoryId).eq("entity_id", m.entityId).select("tax_line_id"),
      );
    } else {
      await must(
        "map tax line",
        db
          .from("category_tax_lines")
          .upsert({ category_id: m.categoryId, entity_id: m.entityId, tax_line_id: m.taxLineId }, { onConflict: "category_id,entity_id" })
          .select("tax_line_id"),
      );
    }
    return { before };
  });
}
