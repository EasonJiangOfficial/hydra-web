import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveMetric } from "@/app/(app)/planning/actions";
import { loadCategoryPanel } from "@/app/(app)/reports/actions";
import * as txReads from "@/app/(app)/transactions/reads";
import * as bank from "@/lib/bank/actions";
import { balanceHistory, listAccounts, listTransactions } from "@/lib/bank/queries";
import { setFollowers } from "@/lib/brand/actions";
import { brandSummary, setFollowersSchema } from "@/lib/brand/model";
import { loadBrandRaw } from "@/lib/brand/queries";
import { loadLayouts, resetLayout, saveLayout } from "@/lib/layout/actions";
import { saveInputSchema } from "@/lib/layout/store";
import * as planning from "@/lib/planning/actions";
import { optionInputSchema, optionPatchSchema, propertyInputSchema, propertyPatchSchema, propertyValueSchema } from "@/lib/planning/properties";
import { repeatRuleSchema } from "@/lib/planning/repeat";
import {
  categorySchema,
  colorSchema,
  createStatusSchema,
  eventPatchSchema,
  eventTitleSchema,
  goalLinkPatchSchema,
  goalMetricPatchSchema,
  goalPatchSchema,
  goalTitleSchema,
  metricKeySchema,
  notesSchema,
  statusLabelSchema,
  taskPatchSchema,
  taskTitleSchema,
} from "@/lib/planning/schemas";
import { todayIn } from "@/lib/planning/dates";
import { categoryColorOf, placeAmong, tasksInStatus } from "@/lib/planning/tasks";
import type { PlanningSnapshot } from "@/lib/planning/types";
import * as reports from "@/lib/reports/queries";
import * as rules from "@/lib/rules/actions";
import { actionsSchema, conditionsSchema } from "@/lib/rules/model";
import { listCategories, listCategoryTaxLines, listRecurring, listRules, listTaxLines, reviewQueue } from "@/lib/rules/queries";
import * as ugc from "@/lib/ugc/actions";
import { createDealFromTemplateSchema } from "@/lib/ugc/templates";
import { resolveWindow } from "@/lib/ugc/analytics";
import { earnedPerDay, listDeals, listDealTemplates, missedViewDays, payoutMatches, postingCalendarMonth, postsNeedingViews } from "@/lib/ugc/queries";
import {
  addPostSchema,
  createDealSchema,
  editPostSchema,
  endDealSchema,
  linkPostsSchema,
  matchPaymentSchema,
  payoutPairSchema,
  payoutRuleKeySchema,
  decidePayoutRuleSchema,
  setDayTargetSchema,
  setViewsSchema,
  unlinkPostSchema,
  updateDealSchema,
} from "@/lib/ugc/schemas";
import { day, defineTool, instant, scopeSchema, ToolError, unwrap, uuid, type ToolCtx, type ToolDef } from "./registry";
import { namedDelete, q, rowOf, usd } from "./tools-confirm";

/**
 * Hydra data tools: every engine's typed queries and actions (ugc, bank, rules, recurring, ledger,
 * planning with reminders, reports, layout). Reads take the owner's session client; writes call
 * the same server actions the pages call, as the owner. Each write returns its inverse for undo.
 */

const STEP = 1024;
const id = <K extends string>(key: K) => z.object({ [key]: uuid } as { [P in K]: typeof uuid });
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
/** An engine's `before` (column names) as action input keys. */
const beforeInput = (before: Record<string, unknown>, drop: string[] = []) =>
  Object.fromEntries(Object.entries(before).filter(([k]) => !drop.includes(k)).map(([k, v]) => [camel(k), v]));
const pick = <T extends object>(o: T, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, (o as Record<string, unknown>)[k]]));

async function snapshot(): Promise<PlanningSnapshot> {
  return unwrap(await planning.loadPlanning());
}
/** The position after the last task in a column. */
const endOf = (snap: PlanningSnapshot, statusId: string) =>
  Math.max(0, ...snap.tasks.filter((t) => t.statusId === statusId).map((t) => t.position)) + STEP;
async function findTask(taskId: string) {
  const task = (await snapshot()).tasks.find((t) => t.id === taskId);
  if (!task) throw new ToolError("That task is gone.");
  return task;
}

// Names for the delete confirms (each null when the row cannot be read).
/** A transaction as `"Coffee" (2026-11-20, -$12.50)`. */
async function txName(transactionId: string) {
  const row = await txReads.getRow(transactionId);
  return row && `${q(row.name)} (${row.posted_on}, ${usd(row.amount_cents)})`;
}
const dealName = async (ctx: ToolCtx, dealId: string) => (await rowOf<{ brand_name: string }>(ctx, "deals", dealId, "brand_name"))?.brand_name ?? null;
const categoryName = async (ctx: ToolCtx, categoryId: string) => (await rowOf<{ name: string }>(ctx, "categories", categoryId, "name"))?.name ?? null;
const planName = async <T extends { id: string }>(pick: (s: PlanningSnapshot) => readonly T[], id: string, label: (x: T) => string) => {
  const x = pick(await snapshot()).find((r) => r.id === id);
  return x ? label(x) : null;
};

// ── Reads ─────────────────────────────────────────────────────────────────

const reads: ToolDef[] = [
  defineTool({
    name: "list_accounts",
    description: "Bank, card, loan and asset accounts with their latest balance (cents).",
    group: "hydra",
    kind: "read",
    input: z.object({ entityId: uuid.optional(), includeClosed: z.boolean().optional() }),
    run: async (ctx, input) => ({ data: await listAccounts(ctx.db, input), summary: "Read accounts" }),
  }),
  defineTool({
    name: "list_transactions",
    description: "Transactions, newest first, 50 per page. Filter by account, business, dates or a search word.",
    group: "hydra",
    kind: "read",
    input: z.object({
      accountId: uuid.optional(),
      entityId: uuid.optional(),
      from: day.optional(),
      to: day.optional(),
      search: z.string().max(200).optional(),
      includeHidden: z.boolean().optional(),
      page: z.int().min(0).optional(),
    }),
    run: async (ctx, input) => ({ data: await listTransactions(ctx.db, input), summary: "Read transactions" }),
  }),
  defineTool({
    name: "get_report",
    description:
      "A money report for a scope and date range: net_worth, cash_flow, spending, income_by_payer, monthly_trend, tax_lines or income_summary. Totals are computed in SQL.",
    group: "hydra",
    kind: "read",
    input: z.object({
      report: z.enum(["net_worth", "cash_flow", "spending", "income_by_payer", "monthly_trend", "tax_lines", "income_summary"]),
      scope: scopeSchema,
      from: day,
      to: day,
    }),
    run: async (ctx, { report, scope, from, to }) => {
      const range = { from, to };
      const fn = {
        net_worth: reports.netWorthSeries,
        cash_flow: reports.cashFlow,
        spending: reports.spendingByCategory,
        income_by_payer: reports.incomeByPayer,
        monthly_trend: reports.monthlyTrend,
        tax_lines: reports.taxLineTotals,
        income_summary: reports.incomeSummary,
      }[report] as (db: typeof ctx.db, s: typeof scope, r: typeof range) => Promise<unknown>;
      return { data: await fn(ctx.db, scope, range), summary: `Read ${report.replace(/_/g, " ")}` };
    },
  }),
  defineTool({
    name: "list_categories",
    description: "Categories (income, expense, transfer), the Schedule C tax lines, and which category maps to which line per business.",
    group: "hydra",
    kind: "read",
    input: z.object({ includeArchived: z.boolean().optional() }),
    run: async (ctx, input) => {
      const [categories, taxLines, categoryTaxLines] = await Promise.all([listCategories(ctx.db, input), listTaxLines(ctx.db), listCategoryTaxLines(ctx.db)]);
      return { data: { categories, taxLines, categoryTaxLines }, summary: "Read categories" };
    },
  }),
  defineTool({
    name: "list_rules",
    description: "Money rules in the order they run.",
    group: "hydra",
    kind: "read",
    input: z.object({}),
    run: async (ctx) => ({ data: await listRules(ctx.db), summary: "Read rules" }),
  }),
  defineTool({
    name: "list_recurring",
    description: "Recurring charges and income found in the bank feed.",
    group: "hydra",
    kind: "read",
    input: z.object({ status: z.enum(["suggested", "confirmed", "dismissed"]).optional() }),
    run: async (ctx, input) => ({ data: await listRecurring(ctx.db, input), summary: "Read recurring" }),
  }),
  defineTool({
    name: "review_queue",
    description: "Transactions that still need a category.",
    group: "hydra",
    kind: "read",
    input: z.object({ entityId: uuid.optional(), page: z.int().min(0).optional() }),
    run: async (ctx, input) => ({ data: await reviewQueue(ctx.db, input), summary: "Read the review queue" }),
  }),
  defineTool({
    name: "list_deals",
    description: "UGC deals with earned, paid, owed, missed and projected cents.",
    group: "hydra",
    kind: "read",
    input: z.object({}),
    run: async (ctx) => ({ data: await listDeals({ now: ctx.now() }), summary: "Read deals" }),
  }),
  defineTool({
    name: "ugc_calendar",
    description: "UGC posting calendar for a month (YYYY-MM), or earned cents per day for a range.",
    group: "hydra",
    kind: "read",
    input: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional(), from: day.optional(), to: day.optional(), dealId: uuid.optional() }),
    run: async (ctx, { month, from, to, dealId }) => {
      if (month) return { data: await postingCalendarMonth({ month, now: ctx.now() }), summary: `Read posting calendar ${month}` };
      if (!from || !to) throw new ToolError("Give a month, or from and to.");
      return { data: await earnedPerDay({ from, to, dealId, now: ctx.now() }), summary: "Read earned per day" };
    },
  }),
  defineTool({
    name: "suggest_payout_matches",
    description:
      "Which open deposit (PayPal, wire, ACH, Zelle: no brand name) pays which UGC deal: owed per pay cycle within 5%, landed after the cycle closed, past payers, learned rules. Plus rule offers. Confirm with confirm_payout_match.",
    group: "hydra",
    kind: "read",
    input: z.object({ dealId: uuid.optional() }),
    run: async (ctx, { dealId }) => {
      const data = await payoutMatches({ now: ctx.now(), dealId });
      return { data, summary: `Found ${data.suggestions.length} payout ${data.suggestions.length === 1 ? "match" : "matches"}` };
    },
  }),
  defineTool({
    name: "posts_needing_views",
    description: "Today's UGC posts that still need a view count, and the past days (missedViewDays) with no reading.",
    group: "hydra",
    kind: "read",
    input: z.object({ days: z.int().min(1).max(90).optional() }),
    run: async (ctx, { days }) => {
      const [today, missed] = await Promise.all([postsNeedingViews({ now: ctx.now() }), missedViewDays({ days, now: ctx.now() })]);
      return { data: { ...today, missedViewDays: missed }, summary: "Read posts needing views" };
    },
  }),
  defineTool({
    name: "list_deal_templates",
    description: "UGC deal templates: brands with a ready pay structure, for create_deal_from_template.",
    group: "hydra",
    kind: "read",
    input: z.object({ includeArchived: z.boolean().optional() }),
    run: async (_ctx, input) => ({ data: await listDealTemplates(input), summary: "Read deal templates" }),
  }),
  defineTool({
    name: "category_month",
    description: "One category for one month (YYYY-MM): total, share, trend and newest rows. key: a category id, or none-expense / none-income.",
    group: "hydra",
    kind: "read",
    input: z.object({ key: z.string().min(1).max(40), scope: scopeSchema, month: z.string().regex(/^\d{4}-\d{2}$/) }),
    run: async (_ctx, input) => ({ data: unwrap(await loadCategoryPanel(input)), summary: `Read a category for ${input.month}` }),
  }),
  defineTool({
    name: "goal_metric_value",
    description: "A goal metric's live value over a date range (net worth, income, UGC revenue, posts per day, category spend and more).",
    group: "hydra",
    kind: "read",
    input: z.object({ metric: metricKeySchema, param: z.string().max(200).nullable().optional(), from: day, to: day }),
    run: async (ctx, { metric, param, from, to }) => {
      const timeZone = await ctx.timeZone();
      const value = await resolveMetric({ key: metric, param: param ?? null, window: { from, to }, today: todayIn(ctx.now(), timeZone), timeZone });
      return { data: { metric, value }, summary: `Read ${metric.replace(/_/g, " ")}` };
    },
  }),
  defineTool({
    name: "get_personal_brand",
    description:
      "The owner's personal Instagram (Personal Brand page): followers, views, likes, comments, engagement rate, posting consistency, top and recent posts. Range 1d, 1w, 2w, 1m or all (default), or from and to days.",
    group: "hydra",
    kind: "read",
    input: z.object({ range: z.enum(["1d", "1w", "2w", "1m", "all"]).optional(), from: day.optional(), to: day.optional() }),
    run: async (ctx, { range, from, to }) => {
      if ((from === undefined) !== (to === undefined)) throw new ToolError("Give both from and to, or neither.");
      const now = ctx.now();
      const raw = await loadBrandRaw(ctx.db, now);
      const win = resolveWindow(from ? "custom" : (range ?? "all"), { now, zone: raw.zone, customStart: from, customEnd: to });
      if (!win) throw new ToolError("from must be on or before to.");
      return { data: brandSummary(raw, win), summary: "Read Personal Brand" };
    },
  }),
  defineTool({
    name: "get_planning",
    description: "Planning: statuses, tasks (with reminders in alertAt), goals with metrics, events and custom properties.",
    group: "hydra",
    kind: "read",
    input: z.object({}),
    run: async () => ({ data: await snapshot(), summary: "Read planning" }),
  }),
  defineTool({
    name: "get_layouts",
    description: "The saved dashboard layouts (desktop and phone).",
    group: "hydra",
    kind: "read",
    input: z.object({}),
    run: async () => ({ data: await loadLayouts(), summary: "Read dashboard layouts" }),
  }),
];

// ── Bank ──────────────────────────────────────────────────────────────────

const accountKind = z.enum(["cash", "card", "loan", "asset"]);
const cents = z.int().min(-1e13).max(1e13);

const bankTools: ToolDef[] = [
  defineTool({
    name: "add_manual_account",
    description: "Add a manual account (cash, card, loan or asset) with an optional balance in cents.",
    group: "hydra",
    kind: "write",
    input: z.object({
      name: z.string().min(1).max(100),
      kind: accountKind,
      entityId: uuid.optional(),
      institution: z.string().max(100).nullable().optional(),
      inNetWorth: z.boolean().optional(),
      balanceCents: cents.optional(),
      balanceAsOf: day.optional(),
    }),
    run: async (_ctx, input) => {
      const { accountId } = unwrap(await bank.addManualAccount(input));
      return {
        data: { accountId },
        summary: `Added account ${input.name}`,
        inverse: { tool: "close_account", input: { accountId } },
        ui: { kind: "openPanel", param: "account", value: accountId },
      };
    },
  }),
  defineTool({
    name: "edit_account",
    description: "Edit an account: nickname, business, in net worth, statement overrides; manual accounts also name, kind, institution, balance.",
    group: "hydra",
    kind: "write",
    input: z.object({
      accountId: uuid,
      nickname: z.string().max(100).nullable().optional(),
      entityId: uuid.optional(),
      inNetWorth: z.boolean().optional(),
      statementBalanceOverrideCents: cents.nullable().optional(),
      statementDueOnOverride: day.nullable().optional(),
      name: z.string().min(1).max(100).optional(),
      kind: accountKind.optional(),
      institution: z.string().max(100).nullable().optional(),
      balanceCents: cents.optional(),
      balanceAsOf: day.optional(),
    }),
    run: async (_ctx, input) => {
      const r = unwrap(await bank.editAccount(input));
      const before = beforeInput(r.before);
      return {
        data: r,
        summary: "Edited an account",
        inverse: Object.keys(before).length ? { tool: "edit_account", input: { accountId: r.accountId, ...before } } : null,
      };
    },
  }),
  defineTool({
    name: "close_account",
    description: "Close an account. It leaves the lists; its history stays.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Close this account",
    gate: namedDelete("Close this account", async (ctx, { accountId }: { accountId: string }) => {
      const a = await rowOf<{ name: string; nickname: string | null; mask: string | null }>(ctx, "accounts", accountId, "name, nickname, mask");
      return a && `Close account ${q(a.nickname || a.name)}${a.mask ? ` (${a.mask})` : ""}`;
    }),
    input: id("accountId"),
    run: async (_ctx, input) => ({ data: unwrap(await bank.closeAccount(input)), summary: "Closed an account", inverse: null }),
  }),
  defineTool({
    name: "add_transaction",
    description: "Add a manual transaction. amountCents is negative for money out.",
    group: "hydra",
    kind: "write",
    input: z.object({
      accountId: uuid,
      postedOn: day,
      amountCents: cents,
      name: z.string().min(1).max(200),
      note: z.string().max(1000).nullable().optional(),
      entityId: uuid.optional(),
    }),
    run: async (_ctx, input) => {
      const { transactionId } = unwrap(await bank.addManualTransaction(input));
      return {
        data: { transactionId },
        summary: `Added ${input.name}`,
        inverse: { tool: "edit_transaction", input: { transactionId, hidden: true } },
        ui: { kind: "openPanel", param: "tx", value: transactionId },
      };
    },
  }),
  defineTool({
    name: "edit_transaction",
    description: "Edit a transaction: name, note, business, hidden; manual ones also date and amount. hidden=true removes it from every view.",
    group: "hydra",
    kind: "write",
    risk: (i) => (i.hidden === true ? "delete" : null),
    describe: (i) => (i.hidden ? "Hide this transaction" : "Edit this transaction"),
    gate: namedDelete(
      "Hide this transaction",
      async (_ctx, { transactionId }: { transactionId: string; hidden?: boolean }) => {
        const name = await txName(transactionId);
        return name && `Hide ${name}`;
      },
      (i: { hidden?: boolean }) => i.hidden === true,
    ),
    input: z.object({
      transactionId: uuid,
      name: z.string().min(1).max(200).optional(),
      note: z.string().max(1000).nullable().optional(),
      hidden: z.boolean().optional(),
      entityId: uuid.optional(),
      postedOn: day.optional(),
      amountCents: cents.optional(),
    }),
    run: async (_ctx, input) => {
      const r = unwrap(await bank.editTransaction(input));
      return {
        data: r,
        summary: input.hidden ? "Hid a transaction" : "Edited a transaction",
        inverse: { tool: "edit_transaction", input: { transactionId: r.transactionId, ...beforeInput(r.before, ["renamed"]) } },
      };
    },
  }),
  defineTool({
    name: "sync_bank",
    description: "Pull new transactions for one bank login now.",
    group: "hydra",
    kind: "write",
    input: id("itemId"),
    run: async (_ctx, input) => ({ data: unwrap(await bank.syncBankItem(input)), summary: "Synced a bank", inverse: null }),
  }),
  defineTool({
    name: "import_file",
    description: "Import a CSV, OFX or QFX file into an account. dryRun first to see the counts.",
    group: "hydra",
    kind: "write",
    bulk: (i) => (i.dryRun ? 0 : "unknown"),
    describe: () => "Import a bank file",
    input: z.object({
      accountId: uuid,
      format: z.enum(["csv", "ofx", "qfx"]),
      content: z.string().min(1).max(5_000_000),
      dryRun: z.boolean().optional(),
      invertSign: z.boolean().optional(),
    }),
    run: async (_ctx, input) => ({ data: unwrap(await bank.importFile(input)), summary: input.dryRun ? "Checked an import" : "Imported a file", inverse: null }),
  }),
  defineTool({
    name: "delete_transaction",
    description: "Delete a manual transaction (with its deal payment, if matched). A bank or imported-file row is hidden instead, not deleted: the feed or file would add it back.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Delete this transaction",
    gate: namedDelete("Delete this transaction", async (ctx, { transactionId }: { transactionId: string }) => {
      const row = await txReads.getRow(transactionId);
      if (!row) return null;
      const what = `${q(row.name)} (${row.posted_on}, ${usd(row.amount_cents)})`;
      if (row.source !== "manual") return `Hide ${what}: ${row.source === "plaid" ? "a bank" : "an imported"} row is hidden, not deleted`;
      const pay = await txReads.dealPayment(transactionId);
      if (!pay) return `Delete ${what}`;
      const deal = await dealName(ctx, pay.deal_id);
      return `Delete ${what} and its payment to deal ${deal ? q(deal) : "(unnamed)"}`;
    }),
    input: id("transactionId"),
    run: async (_ctx, { transactionId }) => {
      // Read first: the fallback undo adds this row back when the delete reports no activity id.
      const row = await txReads.getRow(transactionId);
      if (!row) throw new ToolError("That transaction is gone.");
      const r = await bank.deleteManualTransaction({ transactionId });
      if (r.ok) {
        // The data unit's contract: { ok: true, activityId?, dealPayment? }. The activity undo puts back
        // the exact row and its deal payment; add_transaction is a new row without the payment.
        const { activityId, dealPayment } = r as unknown as { activityId?: string; dealPayment?: boolean };
        return {
          data: { transactionId, deleted: true, dealPayment: dealPayment ?? false },
          summary: `Deleted ${row.name}${dealPayment ? " and its deal payment" : ""}`,
          inverse: activityId
            ? { tool: "undo_activity", input: { id: activityId } }
            : {
                tool: "add_transaction",
                input: { accountId: row.account_id, postedOn: row.posted_on, amountCents: row.amount_cents, name: row.name, note: row.note, ...(row.entity_id ? { entityId: row.entity_id } : {}) },
              },
        };
      }
      if (r.error.code !== "not_manual") return unwrap(r);
      const hid = unwrap(await bank.editTransaction({ transactionId, hidden: true }));
      return {
        data: { transactionId, hidden: true, note: "A bank or imported-file row is hidden, not deleted: the feed or file would add a deleted one back. It is gone from every view." },
        summary: `Hid ${row.name}`,
        inverse: { tool: "edit_transaction", input: { transactionId, ...beforeInput(hid.before) } },
      };
    },
  }),
  defineTool({
    name: "get_balance_history",
    description: "One account's daily balances (cents), oldest first.",
    group: "hydra",
    kind: "read",
    input: z.object({ accountId: uuid, from: day.optional(), to: day.optional() }),
    run: async (ctx, input) => ({ data: await balanceHistory(ctx.db, input), summary: "Read balance history" }),
  }),
  defineTool({
    name: "get_transaction",
    description: "One transaction in full, the deal its deposit is matched to, and rows that could be its transfer pair.",
    group: "hydra",
    kind: "read",
    input: id("transactionId"),
    run: async (_ctx, { transactionId }) => {
      const row = await txReads.getRow(transactionId);
      if (!row) throw new ToolError("That transaction is gone.");
      const [dealPayment, pairCandidates] = await Promise.all([txReads.dealPayment(transactionId), txReads.pairCandidates(transactionId)]);
      return { data: { row, dealPayment, pairCandidates }, summary: `Read ${row.name}` };
    },
  }),
  defineTool({
    name: "transfer_suggestions",
    description: "Possible transfers between two cash accounts, waiting for a yes (pair_transfers) or a no (reject_transfer_suggestion).",
    group: "hydra",
    kind: "read",
    input: z.object({}),
    run: async () => ({ data: await txReads.transferSuggestions(), summary: "Read transfer suggestions" }),
  }),
];

// ── Rules, categories, recurring, transfers (ledger) ─────────────────────

const categoryKind = z.enum(["income", "expense", "transfer"]);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const ruleTools: ToolDef[] = [
  defineTool({
    name: "preview_rule",
    description: "Show which recent transactions a rule would match, before saving it.",
    group: "hydra",
    kind: "read",
    input: z.object({ conditions: conditionsSchema, actions: actionsSchema, days: z.int().min(1).max(3660).optional() }),
    run: async (_ctx, input) => ({ data: unwrap(await rules.previewRule(input)), summary: "Previewed a rule" }),
  }),
  defineTool({
    name: "create_rule",
    description: "Add a money rule. applyFrom (YYYY-MM-DD) also runs every rule over rows posted since then.",
    group: "hydra",
    kind: "write",
    bulk: (i) => (i.applyFrom ? "unknown" : 1),
    describe: () => "Add a rule and apply it to past rows",
    input: z.object({ conditions: conditionsSchema, actions: actionsSchema, enabled: z.boolean().optional(), first: z.boolean().optional(), applyFrom: day.optional() }),
    run: async (_ctx, input) => {
      const r = unwrap(await rules.createRule(input));
      return { data: r, summary: "Added a rule", inverse: { tool: "delete_rule", input: { id: r.rule.id } } };
    },
  }),
  defineTool({
    name: "update_rule",
    description: "Change a rule's conditions, actions or on/off.",
    group: "hydra",
    kind: "write",
    bulk: (i) => (i.applyFrom ? "unknown" : 1),
    describe: () => "Change a rule and apply it to past rows",
    input: z.object({ id: uuid, conditions: conditionsSchema.optional(), actions: actionsSchema.optional(), enabled: z.boolean().optional(), applyFrom: day.optional() }),
    run: async (_ctx, input) => {
      const r = unwrap(await rules.updateRule(input));
      const { conditions, actions, enabled } = r.before;
      return { data: r, summary: "Changed a rule", inverse: { tool: "update_rule", input: { id: input.id, conditions, actions, enabled } } };
    },
  }),
  defineTool({
    name: "delete_rule",
    description: "Delete a money rule.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Delete this rule",
    gate: namedDelete("Delete this rule", async (ctx, { id: ruleId }: { id: string }) => {
      const all = await listRules(ctx.db);
      const i = all.findIndex((r) => r.id === ruleId);
      if (i < 0) return null;
      const c = all[i].conditions[0];
      const when = c ? `: ${c.field} ${c.op.replace(/_/g, " ")} ${Array.isArray(c.value) ? c.value.join(", ") : c.value}`.slice(0, 120) : "";
      return `Delete rule ${i + 1} of ${all.length}${when}`;
    }),
    input: id("id"),
    run: async (_ctx, input) => {
      const { before } = unwrap(await rules.deleteRule(input));
      return {
        data: { before },
        summary: "Deleted a rule",
        inverse: { tool: "create_rule", input: { conditions: before.conditions, actions: before.actions, enabled: before.enabled } },
      };
    },
  }),
  defineTool({
    name: "reorder_rules",
    description: "Set the order rules run in (every rule id, first to last).",
    group: "hydra",
    kind: "write",
    bulk: (i) => i.ids.length,
    describe: () => "Reorder the rules",
    input: z.object({ ids: z.array(uuid).max(1000) }),
    run: async (ctx, input) => {
      const before = (await listRules(ctx.db)).map((r) => r.id);
      return { data: unwrap(await rules.reorderRules(input)), summary: "Reordered rules", inverse: { tool: "reorder_rules", input: { ids: before } } };
    },
  }),
  defineTool({
    name: "apply_rules",
    description: "Run the rules over one transaction, or over a date range (rows set by hand are never touched).",
    group: "hydra",
    kind: "write",
    bulk: (i) => (i.transactionId ? 1 : "unknown"),
    describe: () => "Run the rules over a date range",
    input: z.object({ transactionId: uuid.optional(), from: day.optional(), to: day.optional() }),
    run: async (_ctx, { transactionId, from, to }) => ({
      data: unwrap(await rules.applyRules(transactionId ? { transactionId } : { from, to })),
      summary: "Applied rules",
      inverse: null,
    }),
  }),
  defineTool({
    name: "set_transaction_category",
    description: "Set a transaction's category (null clears it) and optionally its business. Counts as a manual edit.",
    group: "hydra",
    kind: "write",
    input: z.object({ transactionId: uuid, categoryId: uuid.nullable(), entityId: uuid.optional() }),
    run: async (_ctx, input) => {
      const r = unwrap(await rules.setTransactionCategory(input));
      return {
        data: r,
        summary: "Set a category",
        inverse: { tool: "set_transaction_category", input: { transactionId: input.transactionId, categoryId: r.before.category_id, entityId: r.before.entity_id } },
      };
    },
  }),
  defineTool({
    name: "pair_transfers",
    description: "Mark two transactions as one transfer between own accounts (left out of income and spending).",
    group: "hydra",
    kind: "write",
    input: z.object({ aId: uuid, bId: uuid }),
    run: async (_ctx, input) => ({
      data: unwrap(await rules.pairTransfers(input)),
      summary: "Paired a transfer",
      inverse: { tool: "unpair_transfer", input: { transactionId: input.aId } },
    }),
  }),
  defineTool({
    name: "unpair_transfer",
    description: "Remove a transfer pairing.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Remove this transfer pairing",
    gate: namedDelete("Remove this transfer pairing", async (_ctx, { transactionId }: { transactionId: string }) => {
      const name = await txName(transactionId);
      return name && `Unpair the transfer ${name}`;
    }),
    input: id("transactionId"),
    run: async (_ctx, input) => ({ data: unwrap(await rules.unpairTransfer(input)), summary: "Unpaired a transfer", inverse: null }),
  }),
  defineTool({
    name: "reject_transfer_suggestion",
    description: "Say no to a suggested transfer: the two rows are never suggested as a pair again.",
    group: "hydra",
    kind: "write",
    input: z.object({ aId: uuid, bId: uuid }),
    run: async (_ctx, input) => ({ data: unwrap(await rules.rejectTransferSuggestion(input)), summary: "Rejected a transfer suggestion", inverse: null }),
  }),
  defineTool({
    name: "auto_pair_transfers",
    description: "Pair card and loan payments in a date range. Transfers between two cash accounts are only suggested (Transactions, Needs review).",
    group: "hydra",
    kind: "write",
    bulk: () => "unknown",
    describe: () => "Pair transfers automatically",
    input: z.object({ from: day.optional(), to: day.optional(), windowDays: z.int().min(0).max(30).optional() }),
    run: async (_ctx, input) => ({ data: unwrap(await rules.autoPairTransfers(input)), summary: "Paired transfers", inverse: null }),
  }),
  defineTool({
    name: "confirm_recurring",
    description: "Confirm a detected recurring series.",
    group: "hydra",
    kind: "write",
    input: id("id"),
    run: async (_ctx, input) => ({ data: unwrap(await rules.confirmRecurring(input)), summary: "Confirmed a recurring charge", inverse: null }),
  }),
  defineTool({
    name: "dismiss_recurring",
    description: "Dismiss a recurring series and unlink its transactions.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Dismiss this recurring charge",
    gate: namedDelete("Dismiss this recurring charge", async (ctx, { id: seriesId }: { id: string }) => {
      const s = await rowOf<{ name: string; average_amount_cents: number }>(ctx, "recurring", seriesId, "name, average_amount_cents");
      return s && `Dismiss the recurring ${q(s.name)} (about ${usd(s.average_amount_cents)})`;
    }),
    input: id("id"),
    run: async (_ctx, input) => ({ data: unwrap(await rules.dismissRecurring(input)), summary: "Dismissed a recurring charge", inverse: null }),
  }),
  defineTool({
    name: "detect_recurring",
    description: "Look for recurring charges and income in the bank feed now.",
    group: "hydra",
    kind: "write",
    bulk: () => "unknown",
    describe: () => "Detect recurring charges",
    input: z.object({}),
    run: async () => ({ data: unwrap(await rules.detectRecurringNow()), summary: "Detected recurring charges", inverse: null }),
  }),
  defineTool({
    name: "create_category",
    description: "Add a category (two levels at most).",
    group: "hydra",
    kind: "write",
    input: z.object({ name: z.string().min(1).max(60), kind: categoryKind, entityId: uuid.nullable().optional(), parentId: uuid.nullable().optional(), color: color.nullable().optional() }),
    run: async (_ctx, input) => {
      const { category } = unwrap(await rules.createCategory(input));
      return { data: category, summary: `Added category ${category.name}`, inverse: { tool: "delete_category", input: { id: category.id } } };
    },
  }),
  defineTool({
    name: "update_category",
    description: "Rename, move, recolor or archive a category.",
    group: "hydra",
    kind: "write",
    input: z.object({
      id: uuid,
      name: z.string().min(1).max(60).optional(),
      kind: categoryKind.optional(),
      entityId: uuid.nullable().optional(),
      parentId: uuid.nullable().optional(),
      color: color.nullable().optional(),
      archived: z.boolean().optional(),
    }),
    run: async (_ctx, input) => {
      const r = unwrap(await rules.updateCategory(input));
      const b = r.before;
      return {
        data: r.category,
        summary: `Changed category ${r.category.name}`,
        inverse: {
          tool: "update_category",
          input: { id: b.id, name: b.name, kind: b.kind, entityId: b.entity_id, parentId: b.parent_id, color: b.color, archived: b.archived },
        },
      };
    },
  }),
  defineTool({
    name: "delete_category",
    description: "Delete a category. Its transactions lose the category.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Delete this category",
    gate: namedDelete("Delete this category", async (ctx, { id: categoryId }: { id: string }) => {
      const name = await categoryName(ctx, categoryId);
      return name && `Delete category ${q(name)}`;
    }),
    input: id("id"),
    run: async (_ctx, input) => {
      const { before: b } = unwrap(await rules.deleteCategory(input));
      return {
        data: { before: b },
        summary: `Deleted category ${b.name}`,
        inverse: { tool: "create_category", input: { name: b.name, kind: b.kind, entityId: b.entity_id, parentId: b.parent_id, color: b.color } },
      };
    },
  }),
  defineTool({
    name: "merge_categories",
    description: "Move every row of one category into another and delete the first.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Merge these categories (the first one is deleted)",
    gate: namedDelete("Merge these categories (the first one is deleted)", async (ctx, { fromId, intoId }: { fromId: string; intoId: string }) => {
      const [from, into] = await Promise.all([categoryName(ctx, fromId), categoryName(ctx, intoId)]);
      return from && into && `Merge ${q(from)} into ${q(into)} (${q(from)} is deleted)`;
    }),
    input: z.object({ fromId: uuid, intoId: uuid }),
    run: async (_ctx, input) => ({ data: unwrap(await rules.mergeCategories(input)), summary: "Merged categories", inverse: null }),
  }),
  defineTool({
    name: "map_category_tax_line",
    description: "Map a category to a Schedule C line for one business (taxLineId null removes the map).",
    group: "hydra",
    kind: "write",
    risk: (i) => (i.taxLineId === null ? "delete" : null),
    describe: () => "Remove this tax line map",
    gate: namedDelete(
      "Remove this tax line map",
      async (ctx, { categoryId }: { categoryId: string; taxLineId: string | null }) => {
        const name = await categoryName(ctx, categoryId);
        return name && `Remove the tax line map of ${q(name)}`;
      },
      (i: { taxLineId: string | null }) => i.taxLineId === null,
    ),
    input: z.object({ categoryId: uuid, entityId: uuid, taxLineId: uuid.nullable() }),
    run: async (_ctx, input) => {
      const { before } = unwrap(await rules.mapCategoryTaxLine(input));
      return { data: { before }, summary: "Mapped a tax line", inverse: { tool: "map_category_tax_line", input: { ...input, taxLineId: before } } };
    },
  }),
];

// ── UGC ───────────────────────────────────────────────────────────────────

const ugcTools: ToolDef[] = [
  defineTool({
    name: "create_deal",
    description: "Add a UGC deal: brandName and startDate, plus any pay field (base, CPM, bonus tiers, targets).",
    group: "hydra",
    kind: "write",
    input: createDealSchema.omit({ source: true, sourceId: true }),
    run: async (_ctx, input) => {
      const deal = unwrap(await ugc.createDeal(input));
      return {
        data: deal,
        summary: `Added deal ${input.brandName}`,
        inverse: { tool: "delete_deal", input: { id: deal.id } },
        ui: { kind: "openPanel", param: "deal", value: deal.id },
      };
    },
  }),
  defineTool({
    name: "create_deal_from_template",
    description: "Add a UGC deal from a deal template (list_deal_templates): same brand and pay, new dates.",
    group: "hydra",
    kind: "write",
    input: createDealFromTemplateSchema,
    run: async (_ctx, input) => {
      const deal = unwrap(await ugc.createDealFromTemplate(input));
      return {
        data: deal,
        summary: `Added deal ${deal.brand_name}`,
        inverse: { tool: "delete_deal", input: { id: deal.id } },
        ui: { kind: "openPanel", param: "deal", value: deal.id },
      };
    },
  }),
  defineTool({
    name: "update_deal",
    description: "Change a deal's fields. New rates apply to new videos only.",
    group: "hydra",
    kind: "write",
    input: updateDealSchema,
    run: async (_ctx, input) => ({ data: unwrap(await ugc.updateDeal(input)), summary: "Changed a deal", inverse: null }),
  }),
  defineTool({
    name: "pause_deal",
    description: "Pause an active deal.",
    group: "hydra",
    kind: "write",
    input: id("id"),
    run: async (_ctx, input) => ({ data: unwrap(await ugc.pauseDeal(input)), summary: "Paused a deal", inverse: { tool: "resume_deal", input } }),
  }),
  defineTool({
    name: "resume_deal",
    description: "Resume a paused deal.",
    group: "hydra",
    kind: "write",
    input: id("id"),
    run: async (_ctx, input) => ({ data: unwrap(await ugc.resumeDeal(input)), summary: "Resumed a deal", inverse: { tool: "pause_deal", input } }),
  }),
  defineTool({
    name: "end_deal",
    description: "End a deal (optionally on endDate).",
    group: "hydra",
    kind: "write",
    input: endDealSchema,
    run: async (_ctx, input) => ({ data: unwrap(await ugc.endDeal(input)), summary: "Ended a deal", inverse: null }),
  }),
  defineTool({
    name: "delete_deal",
    description: "Delete a deal with its posts and payments.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Delete this deal and its posts",
    gate: namedDelete("Delete this deal and its posts", async (ctx, { id: dealId }: { id: string }) => {
      const name = await dealName(ctx, dealId);
      return name && `Delete deal ${q(name)} with its posts and payments`;
    }),
    input: id("id"),
    run: async (_ctx, input) => ({ data: unwrap(await ugc.deleteDeal(input)), summary: "Deleted a deal", inverse: null }),
  }),
  defineTool({
    name: "add_post",
    description: "Add a UGC video post by URL to a deal (rates are copied from the deal).",
    group: "hydra",
    kind: "write",
    input: addPostSchema.omit({ source: true }),
    run: async (_ctx, input) => {
      const r = unwrap(await ugc.addPost(input));
      return { data: r, summary: "Added a post", inverse: r.created ? { tool: "delete_post", input: { id: r.post.id } } : null };
    },
  }),
  defineTool({
    name: "edit_post",
    description: "Edit a post: URL, platform, account, time, group, title, deal, manual price.",
    group: "hydra",
    kind: "write",
    input: editPostSchema,
    run: async (_ctx, input) => ({ data: unwrap(await ugc.editPost(input)), summary: "Edited a post", inverse: null }),
  }),
  defineTool({
    name: "exclude_post",
    description: "Exclude a video from pay (it pays $0).",
    group: "hydra",
    kind: "write",
    input: id("id"),
    run: async (_ctx, input) => ({ data: unwrap(await ugc.excludePost(input)), summary: "Excluded a video", inverse: { tool: "include_post", input } }),
  }),
  defineTool({
    name: "include_post",
    description: "Put an excluded video back into pay.",
    group: "hydra",
    kind: "write",
    input: id("id"),
    run: async (_ctx, input) => ({ data: unwrap(await ugc.unexcludePost(input)), summary: "Included a video", inverse: { tool: "exclude_post", input } }),
  }),
  defineTool({
    name: "link_posts",
    description: "Link posts of one deal as one video (the same video on several platforms is paid once).",
    group: "hydra",
    kind: "write",
    input: linkPostsSchema,
    run: async (_ctx, input) => {
      const r = unwrap(await ugc.linkPosts(input));
      return { data: r, summary: `Linked ${input.postIds.length} posts as one video`, inverse: null };
    },
  }),
  defineTool({
    name: "unlink_post",
    description: "Take a post out of its video so it is paid on its own.",
    group: "hydra",
    kind: "write",
    input: unlinkPostSchema,
    run: async (_ctx, input) => ({ data: unwrap(await ugc.unlinkPost(input)), summary: "Unlinked a post", inverse: null }),
  }),
  defineTool({
    name: "delete_post",
    description: "Delete a post and its view readings.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Delete this post",
    gate: namedDelete("Delete this post", async (ctx, { id: postId }: { id: string }) => {
      const p = await rowOf<{ title: string | null; url: string; posted_at: string | null; deal_id: string | null }>(ctx, "posts", postId, "title, url, posted_at, deal_id");
      if (!p) return null;
      const deal = p.deal_id ? await dealName(ctx, p.deal_id) : null;
      return `Delete the post ${q(p.title || p.url)}${p.posted_at ? ` from ${p.posted_at.slice(0, 10)}` : ""}${deal ? ` on ${q(deal)}` : ""} and its view readings`;
    }),
    input: id("id"),
    run: async (_ctx, input) => ({ data: unwrap(await ugc.deletePost(input)), summary: "Deleted a post", inverse: null }),
  }),
  defineTool({
    name: "set_views",
    description: "Record view counts (one reading per post per day). A lower count or a 10x jump is held unless force.",
    group: "hydra",
    kind: "write",
    bulk: (i) => i.items.length,
    describe: () => "Record view counts",
    input: setViewsSchema,
    run: async (_ctx, input) => ({ data: unwrap(await ugc.setViews(input)), summary: `Recorded views for ${input.items.length} posts`, inverse: null }),
  }),
  defineTool({
    name: "set_followers",
    description: "Save today's Instagram follower count on Personal Brand (the owner's day). A second save that day replaces it.",
    group: "hydra",
    kind: "write",
    input: setFollowersSchema,
    run: async (_ctx, input) => {
      const r = unwrap(await setFollowers(input));
      return { data: r, summary: `Set followers for ${r.day}`, inverse: null };
    },
  }),
  defineTool({
    name: "set_day_target",
    description: "Override one day's posting target for a deal (0 = day off; null removes the override).",
    group: "hydra",
    kind: "write",
    risk: (i) => (i.target === null ? "delete" : null),
    describe: () => "Remove this day's target override",
    gate: namedDelete(
      "Remove this day's target override",
      async (ctx, { dealId, day: on }: { dealId: string; day: string; target: number | null }) => {
        const name = await dealName(ctx, dealId);
        return name && `Remove the ${on} target override on ${q(name)}`;
      },
      (i: { target: number | null }) => i.target === null,
    ),
    input: setDayTargetSchema,
    run: async (_ctx, input) => ({ data: unwrap(await ugc.setDayTarget(input)), summary: "Set a day target", inverse: null }),
  }),
  defineTool({
    name: "match_payment",
    description: "Match a bank deposit to a deal (one deposit, one deal).",
    group: "hydra",
    kind: "write",
    input: matchPaymentSchema,
    run: async (_ctx, input) => ({
      data: unwrap(await ugc.matchPayment(input)),
      summary: "Matched a payment",
      inverse: { tool: "unmatch_payment", input: { transactionId: input.transactionId } },
    }),
  }),
  defineTool({
    name: "unmatch_payment",
    description: "Remove a deposit's match to a deal.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Unmatch this payment",
    gate: namedDelete("Unmatch this payment", async (ctx, { transactionId }: { transactionId: string }) => {
      const [name, pay] = await Promise.all([txName(transactionId), txReads.dealPayment(transactionId)]);
      const deal = pay ? await dealName(ctx, pay.deal_id) : null;
      return name && `Unmatch ${name}${deal ? ` from deal ${q(deal)}` : ""}`;
    }),
    input: id("transactionId"),
    run: async (_ctx, input) => ({ data: unwrap(await ugc.unmatchPayment(input)), summary: "Unmatched a payment", inverse: null }),
  }),
  defineTool({
    name: "confirm_payout_match",
    description:
      "Confirm a suggested payout from suggest_payout_matches: matches the deposit to the deal at the deposit's own amount and day, so Paid and Owed update.",
    group: "hydra",
    kind: "write",
    input: payoutPairSchema,
    run: async (_ctx, input) => ({
      data: unwrap(await ugc.confirmPayoutMatch(input)),
      summary: "Confirmed a payout match",
      inverse: { tool: "unmatch_payment", input: { transactionId: input.transactionId } },
    }),
  }),
  defineTool({
    name: "reject_payout_match",
    description: 'Say "Not this" to a suggested payout: that deposit is never suggested for that deal again.',
    group: "hydra",
    kind: "write",
    input: payoutPairSchema,
    run: async (_ctx, input) => ({
      data: unwrap(await ugc.rejectPayoutMatch(input)),
      summary: "Turned down a payout match",
      inverse: { tool: "undo_reject_payout_match", input },
    }),
  }),
  defineTool({
    name: "undo_reject_payout_match",
    description: 'Take back a "Not this": the deposit can be suggested for that deal again.',
    group: "hydra",
    kind: "write",
    input: payoutPairSchema,
    run: async (_ctx, input) => ({
      data: unwrap(await ugc.undoRejectPayoutMatch(input)),
      summary: "Took back a payout Not this",
      inverse: { tool: "reject_payout_match", input },
    }),
  }),
  defineTool({
    name: "decide_payout_rule",
    description: "Keep (accepted) or turn down (declined) a learned payout rule from suggest_payout_matches' rule offers.",
    group: "hydra",
    kind: "write",
    input: decidePayoutRuleSchema,
    run: async (_ctx, input) => ({ data: unwrap(await ugc.decidePayoutRule(input)), summary: `Payout rule ${input.decision}` }),
  }),
  defineTool({
    name: "remove_payout_rule",
    description: "Forget a payout rule answer: a kept rule stops applying, a turned-down one can be offered again.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Remove this payout rule",
    gate: namedDelete("Remove this payout rule", async (ctx, { dealId, payerKey }: { dealId: string; payerKey: string }) => {
      const name = await dealName(ctx, dealId);
      return name && `Remove the payout rule for ${q(payerKey)} on ${q(name)}`;
    }),
    input: payoutRuleKeySchema,
    run: async (_ctx, input) => ({ data: unwrap(await ugc.removePayoutRule(input)), summary: "Removed a payout rule" }),
  }),
];

// ── Planning (tasks, reminders, goals, events, statuses, properties) ──────

const createTaskInput = z.object({
  title: taskTitleSchema,
  id: uuid.optional(),
  statusId: uuid.optional(),
  position: z.number().optional(),
  goalId: uuid.nullable().optional(),
  category: categorySchema.nullable().optional(),
  dueDate: day.nullable().optional(),
  alertAt: instant.nullable().optional(),
  repeatRule: repeatRuleSchema.nullable().optional(),
  notes: notesSchema.optional(),
});

const EVENT_UNDO_KEYS = ["title", "startsAt", "endsAt", "allDay", "category", "repeat", "notes", "alertAt"];
const GOAL_UNDO_KEYS = ["title", "notes", "category", "startDate", "deadline", "position"];

const planningTools: ToolDef[] = [
  defineTool({
    name: "create_task",
    description: "Add a task. alertAt makes it a reminder; repeatRule repeats it. Goes to the first open status unless statusId.",
    group: "hydra",
    kind: "write",
    input: createTaskInput,
    run: async (_ctx, input) => {
      const snap = await snapshot();
      const open = [...snap.statuses].sort((a, b) => a.position - b.position).find((s) => !s.isDone);
      const statusId = input.statusId ?? open?.id;
      if (!statusId) throw new ToolError("Add a status first.");
      const task = unwrap(
        await planning.createTask({
          id: input.id ?? randomUUID(),
          title: input.title,
          statusId,
          position: input.position ?? endOf(snap, statusId),
          goalId: input.goalId ?? null,
          category: input.category ?? null,
          dueDate: input.dueDate ?? null,
          alertAt: input.alertAt ?? null,
          repeatRule: input.repeatRule ?? null,
        }),
      );
      if (input.notes) unwrap(await planning.updateTask(task.id, { notes: input.notes }));
      return {
        data: task,
        summary: `${task.alertAt ? "Reminder" : "Task"}: ${task.title}`,
        inverse: { tool: "delete_task", input: { id: task.id } },
        ui: { kind: "openPanel", param: "task", value: task.id },
      };
    },
  }),
  defineTool({
    name: "update_task",
    description: "Change a task: title, notes, statusId (lands at the end of it), goal, category, due date, repeat, alertAt. move_task moves by status name.",
    group: "hydra",
    kind: "write",
    input: z.object({ id: uuid, patch: taskPatchSchema }),
    // Removing a reminder is a deletion (clear_reminder asks too): the same change here asks first.
    risk: (i) => (i.patch.alertAt === null ? "delete" : null),
    describe: () => "Remove this reminder",
    gate: namedDelete(
      "Remove this reminder",
      (_ctx, { id: taskId }: { id: string; patch: { alertAt?: string | null } }) => planName((s) => s.tasks, taskId, (t) => `Remove the reminder on ${q(t.title)}`),
      (i: { patch: { alertAt?: string | null } }) => i.patch.alertAt === null,
    ),
    run: async (_ctx, { id: taskId, patch: asked }) => {
      const snap = await snapshot();
      const before = snap.tasks.find((t) => t.id === taskId);
      if (!before) throw new ToolError("That task is gone.");
      // A new column without a position lands at the end of it, as a drag to the bottom would.
      const moved = asked.statusId !== undefined && asked.statusId !== before.statusId && asked.position === undefined;
      const patch = moved ? { ...asked, position: endOf(snap, asked.statusId!) } : asked;
      const task = unwrap(await planning.updateTask(taskId, patch));
      return { data: task, summary: `Changed ${task.title}`, inverse: { tool: "update_task", input: { id: taskId, patch: pick(before, Object.keys(patch)) } } };
    },
  }),
  defineTool({
    name: "complete_task",
    description: "Mark a task done (or not done).",
    group: "hydra",
    kind: "write",
    input: z.object({ id: uuid, done: z.boolean() }),
    run: async (_ctx, { id: taskId, done }) => {
      const before = await findTask(taskId);
      const task = unwrap(await planning.completeTask(taskId, done));
      return {
        data: task,
        summary: `${done ? "Done" : "Reopened"}: ${task.title}`,
        inverse: { tool: "update_task", input: { id: taskId, patch: { statusId: before.statusId, position: before.position } } },
      };
    },
  }),
  defineTool({
    name: "delete_task",
    description: "Delete a task (and its reminder).",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Delete this task",
    gate: namedDelete("Delete this task", (_ctx, { id: taskId }: { id: string }) =>
      planName((s) => s.tasks, taskId, (t) => `Delete task ${q(t.title)}${t.alertAt ? " and its reminder" : ""}`),
    ),
    input: id("id"),
    run: async (_ctx, { id: taskId }) => {
      const t = await findTask(taskId);
      unwrap(await planning.deleteTask(taskId));
      return {
        data: { id: taskId },
        summary: `Deleted ${t.title}`,
        inverse: {
          tool: "create_task",
          input: { id: t.id, title: t.title, statusId: t.statusId, position: t.position, goalId: t.goalId, category: t.category, dueDate: t.dueDate, alertAt: t.alertAt, repeatRule: t.repeatRule, notes: t.notes || undefined },
        },
      };
    },
  }),
  defineTool({
    name: "set_reminder",
    description: "Set when Hydra reminds the owner about a task or event (ISO time with offset).",
    group: "hydra",
    kind: "write",
    input: z.object({ kind: z.enum(["task", "event"]), id: uuid, alertAt: instant }),
    run: async (_ctx, { kind, id: itemId, alertAt }) => {
      const snap = await snapshot();
      const before = (kind === "task" ? snap.tasks : snap.events).find((x) => x.id === itemId)?.alertAt ?? null;
      const item = kind === "task" ? unwrap(await planning.setTaskAlert(itemId, alertAt)) : unwrap(await planning.setEventAlert(itemId, alertAt));
      return {
        data: item,
        summary: `Reminder set: ${item.title}`,
        inverse: before ? { tool: "set_reminder", input: { kind, id: itemId, alertAt: before } } : { tool: "clear_reminder", input: { kind, id: itemId } },
      };
    },
  }),
  defineTool({
    name: "clear_reminder",
    description: "Remove a task's or event's reminder.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Remove this reminder",
    gate: namedDelete("Remove this reminder", (_ctx, { kind, id: itemId }: { kind: "task" | "event"; id: string }) =>
      planName<{ id: string; title: string }>((s) => (kind === "task" ? s.tasks : s.events), itemId, (x) => `Remove the reminder on ${q(x.title)}`),
    ),
    input: z.object({ kind: z.enum(["task", "event"]), id: uuid }),
    run: async (_ctx, { kind, id: itemId }) => {
      const snap = await snapshot();
      const before = (kind === "task" ? snap.tasks : snap.events).find((x) => x.id === itemId)?.alertAt ?? null;
      const item = kind === "task" ? unwrap(await planning.clearTaskAlert(itemId)) : unwrap(await planning.clearEventAlert(itemId));
      return { data: item, summary: `Reminder removed: ${item.title}`, inverse: before ? { tool: "set_reminder", input: { kind, id: itemId, alertAt: before } } : null };
    },
  }),
  defineTool({
    name: "create_goal",
    description: "Add a goal.",
    group: "hydra",
    kind: "write",
    input: z.object({
      title: goalTitleSchema,
      id: uuid.optional(),
      position: z.number().optional(),
      category: categorySchema.nullable().optional(),
      startDate: day.nullable().optional(),
      deadline: day.nullable().optional(),
    }),
    run: async (_ctx, input) => {
      const snap = await snapshot();
      const goal = unwrap(
        await planning.createGoal({
          id: input.id ?? randomUUID(),
          title: input.title,
          position: input.position ?? Math.max(0, ...snap.goals.map((g) => g.position)) + STEP,
          category: input.category ?? null,
          startDate: input.startDate ?? null,
          deadline: input.deadline ?? null,
        }),
      );
      return { data: goal, summary: `Goal: ${goal.title}`, inverse: { tool: "delete_goal", input: { id: goal.id } }, ui: { kind: "openPanel", param: "goal", value: goal.id } };
    },
  }),
  defineTool({
    name: "update_goal",
    description: "Change a goal: title, notes, category, dates, achieved.",
    group: "hydra",
    kind: "write",
    input: z.object({ id: uuid, patch: goalPatchSchema }),
    run: async (_ctx, { id: goalId, patch }) => {
      const before = (await snapshot()).goals.find((g) => g.id === goalId);
      if (!before) throw new ToolError("That goal is gone.");
      const goal = unwrap(await planning.updateGoal(goalId, patch));
      const undo = pick(before, Object.keys(patch).filter((k) => GOAL_UNDO_KEYS.includes(k)));
      if ("achieved" in patch) undo.achieved = before.achievedAt !== null;
      return { data: goal, summary: `Changed goal ${goal.title}`, inverse: { tool: "update_goal", input: { id: goalId, patch: undo } } };
    },
  }),
  defineTool({
    name: "delete_goal",
    description: "Delete a goal with its metrics and links.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Delete this goal",
    gate: namedDelete("Delete this goal", (_ctx, { id: goalId }: { id: string }) =>
      planName((s) => s.goals, goalId, (g) => `Delete goal ${q(g.title)} with its metrics and links`),
    ),
    input: id("id"),
    run: async (_ctx, { id: goalId }) => {
      const g = (await snapshot()).goals.find((x) => x.id === goalId);
      unwrap(await planning.deleteGoal(goalId));
      return {
        data: { id: goalId },
        summary: `Deleted goal ${g?.title ?? ""}`.trim(),
        inverse: g ? { tool: "create_goal", input: { id: g.id, ...pick(g, GOAL_UNDO_KEYS) } } : null,
      };
    },
  }),
  defineTool({
    name: "add_goal_metric",
    description: "Track a live metric on a goal (net worth, income, UGC revenue, posts per day, task progress and more).",
    group: "hydra",
    kind: "write",
    input: z.object({
      goalId: uuid,
      metric: metricKeySchema,
      target: z.number().gt(0),
      param: categorySchema.nullable().optional().describe("category_spend only: the category"),
      id: uuid.optional(),
    }),
    run: async (_ctx, input) => {
      const metric = unwrap(await planning.addGoalMetric({ ...input, id: input.id ?? randomUUID() }));
      return { data: metric, summary: "Added a goal metric", inverse: { tool: "remove_goal_metric", input: { id: metric.id } } };
    },
  }),
  defineTool({
    name: "remove_goal_metric",
    description: "Remove a metric from a goal.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Remove this goal metric",
    gate: namedDelete("Remove this goal metric", async (_ctx, { id: metricId }: { id: string }) => {
      const goal = (await snapshot()).goals.find((g) => g.metrics.some((m) => m.id === metricId));
      const m = goal?.metrics.find((x) => x.id === metricId);
      return goal && m ? `Remove the ${m.metric.replace(/_/g, " ")} metric from goal ${q(goal.title)}` : null;
    }),
    input: id("id"),
    run: async (_ctx, { id: metricId }) => ({ data: unwrap(await planning.removeGoalMetric(metricId)), summary: "Removed a goal metric", inverse: null }),
  }),
  defineTool({
    name: "add_goal_link",
    description: "Link a web page to a goal.",
    group: "hydra",
    kind: "write",
    input: z.object({ goalId: uuid, url: z.string().max(2000), title: z.string().max(200).nullable().optional(), id: uuid.optional() }),
    run: async (_ctx, input) => {
      const link = unwrap(await planning.addGoalLink({ ...input, id: input.id ?? randomUUID() }));
      return { data: link, summary: "Linked a page to a goal", inverse: { tool: "remove_goal_link", input: { id: link.id } } };
    },
  }),
  defineTool({
    name: "remove_goal_link",
    description: "Remove a link from a goal.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Remove this goal link",
    gate: namedDelete("Remove this goal link", async (_ctx, { id: linkId }: { id: string }) => {
      const goal = (await snapshot()).goals.find((g) => g.links.some((l) => l.id === linkId));
      const l = goal?.links.find((x) => x.id === linkId);
      return goal && l ? `Remove the link ${q(l.title || l.url)} from goal ${q(goal.title)}` : null;
    }),
    input: id("id"),
    run: async (_ctx, { id: linkId }) => ({ data: unwrap(await planning.removeGoalLink(linkId)), summary: "Removed a goal link", inverse: null }),
  }),
  defineTool({
    name: "create_event",
    description: "Add a calendar event (ISO times with offset). alertAt makes it a reminder; repeat repeats it.",
    group: "hydra",
    kind: "write",
    input: z.object({
      title: eventTitleSchema,
      startsAt: instant,
      id: uuid.optional(),
      endsAt: instant.nullable().optional(),
      allDay: z.boolean().optional(),
      category: categorySchema.nullable().optional(),
      repeat: repeatRuleSchema.nullable().optional(),
      notes: notesSchema.optional(),
      alertAt: instant.nullable().optional(),
    }),
    run: async (_ctx, input) => {
      const event = unwrap(await planning.createEvent({ ...input, id: input.id ?? randomUUID() }));
      return { data: event, summary: `Event: ${event.title}`, inverse: { tool: "delete_event", input: { id: event.id } } };
    },
  }),
  defineTool({
    name: "update_event",
    description: "Change an event: title, times, all day, category, repeat, notes, alertAt.",
    group: "hydra",
    kind: "write",
    input: z.object({ id: uuid, patch: eventPatchSchema }),
    risk: (i) => (i.patch.alertAt === null ? "delete" : null),
    describe: () => "Remove this reminder",
    gate: namedDelete(
      "Remove this reminder",
      (_ctx, { id: eventId }: { id: string; patch: { alertAt?: string | null } }) => planName((s) => s.events, eventId, (e) => `Remove the reminder on ${q(e.title)}`),
      (i: { patch: { alertAt?: string | null } }) => i.patch.alertAt === null,
    ),
    run: async (_ctx, { id: eventId, patch }) => {
      const before = (await snapshot()).events.find((e) => e.id === eventId);
      if (!before) throw new ToolError("That event is gone.");
      const event = unwrap(await planning.updateEvent(eventId, patch));
      return { data: event, summary: `Changed ${event.title}`, inverse: { tool: "update_event", input: { id: eventId, patch: pick(before, Object.keys(patch)) } } };
    },
  }),
  defineTool({
    name: "delete_event",
    description: "Delete a calendar event (all its repeats).",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Delete this event",
    gate: namedDelete("Delete this event", (_ctx, { id: eventId }: { id: string }) =>
      planName((s) => s.events, eventId, (e) => `Delete event ${q(e.title)} on ${e.startsAt.slice(0, 10)}${e.repeat ? " and all its repeats" : ""}`),
    ),
    input: id("id"),
    run: async (_ctx, { id: eventId }) => {
      const e = (await snapshot()).events.find((x) => x.id === eventId);
      unwrap(await planning.deleteEvent(eventId));
      return {
        data: { id: eventId },
        summary: `Deleted ${e?.title ?? "an event"}`,
        inverse: e ? { tool: "create_event", input: { id: e.id, ...pick(e, EVENT_UNDO_KEYS) } } : null,
      };
    },
  }),
  defineTool({
    name: "create_status",
    description: "Add a board column (status).",
    group: "hydra",
    kind: "write",
    input: createStatusSchema.omit({ id: true }),
    run: async (_ctx, input) => {
      const status = unwrap(await planning.createStatus({ ...input, id: randomUUID() }));
      return { data: status, summary: `Added status ${status.label}`, inverse: { tool: "delete_status", input: { id: status.id, moveTo: null } } };
    },
  }),
  defineTool({
    name: "delete_status",
    description: "Delete a board column; its tasks move to moveTo.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Delete this status",
    gate: namedDelete("Delete this status", async (_ctx, { id: statusId, moveTo }: { id: string; moveTo: string | null }) => {
      const snap = await snapshot();
      const s = snap.statuses.find((x) => x.id === statusId);
      if (!s) return null;
      const n = snap.tasks.filter((t) => t.statusId === statusId).length;
      const to = snap.statuses.find((x) => x.id === moveTo);
      return `Delete status ${q(s.label)}${n ? `; its ${n} task${n === 1 ? "" : "s"} move to ${to ? q(to.label) : "another status"}` : ""}`;
    }),
    input: z.object({ id: uuid, moveTo: uuid.nullable() }),
    run: async (_ctx, input) => ({ data: unwrap(await planning.deleteStatus(input.id, input.moveTo)), summary: "Deleted a status", inverse: null }),
  }),
  defineTool({
    name: "update_status",
    // Label and color only; whether the status counts as done is set_status_done (asks first, activity undo).
    description: "Rename or recolor a board column (status). Color is a #rrggbb hex.",
    group: "hydra",
    kind: "write",
    input: z.object({ id: uuid, patch: z.strictObject({ label: statusLabelSchema.optional(), color: colorSchema.optional() }).refine((p) => Object.keys(p).length > 0, "Empty patch") }),
    run: async (_ctx, { id: statusId, patch }) => {
      const before = (await snapshot()).statuses.find((x) => x.id === statusId);
      const status = unwrap(await planning.updateStatus(statusId, patch));
      // The undo puts back only the fields this call changed, so a later rename is not reverted.
      const undo = before ? Object.fromEntries(Object.keys(patch).map((k) => [k, before[k as keyof typeof patch]])) : null;
      return { data: status, summary: `Updated status ${status.label}`, inverse: undo ? { tool: "update_status", input: { id: statusId, patch: undo } } : null };
    },
  }),
  defineTool({
    name: "set_status_done",
    description: "Set whether a board column (status) counts as done. The completed dates of its tasks change with it.",
    group: "hydra",
    kind: "write",
    // Always asks: flipping done rewrites completed_at on every task in the status.
    gate: async (_ctx, { id: statusId, isDone }: { id: string; isDone: boolean }) => {
      const snap = await snapshot().catch(() => null);
      const s = snap?.statuses.find((x) => x.id === statusId);
      const n = snap ? snap.tasks.filter((t) => t.statusId === statusId).length : null;
      const what = `Mark ${s ? `status ${q(s.label)}` : "this status"} as ${isDone ? "done" : "not done"}`;
      const tasks = n === null ? "its tasks" : `its ${n} task${n === 1 ? "" : "s"}`;
      return { reason: "bulk", summary: `${what}; completed dates change on ${tasks}`, danger: false };
    },
    input: z.object({ id: uuid, isDone: z.boolean() }),
    run: async (_ctx, { id: statusId, isDone }) => {
      const r = await planning.updateStatus(statusId, { isDone });
      const status = unwrap(r);
      // The activity holds the status row and every task row the done trigger rewrote; its undo puts all of them back.
      const activityId = (r as { activityId?: string | null }).activityId ?? null;
      return {
        data: { ...status, activityId },
        summary: `Marked status ${status.label} as ${isDone ? "done" : "not done"}`,
        inverse: activityId ? { tool: "undo_activity", input: { id: activityId } } : null,
      };
    },
  }),
  defineTool({
    name: "update_category_color",
    // Planning categories only; a transaction category's color is update_category.
    description:
      "Color a Planning category (the free-text category on tasks, goals and events; its board column and pills). Color is a #rrggbb hex; null clears it.",
    group: "hydra",
    kind: "write",
    input: z.object({ category: categorySchema, color: colorSchema.nullable() }),
    run: async (_ctx, { category, color }) => {
      const before = categoryColorOf(await snapshot(), category);
      const saved = unwrap(await planning.setCategoryColor(category, color));
      return {
        data: saved,
        summary: saved.color ? `Colored category ${saved.category}` : `Cleared the color of category ${saved.category}`,
        inverse: { tool: "update_category_color", input: { category: saved.category, color: before } },
      };
    },
  }),
  defineTool({
    name: "create_property",
    description: "Add a custom task property (text, number, select and more).",
    group: "hydra",
    kind: "write",
    input: propertyInputSchema.omit({ id: true }),
    run: async (_ctx, input) => {
      const prop = unwrap(await planning.createProperty({ ...input, id: randomUUID() }));
      return { data: prop, summary: `Added property ${prop.name}`, inverse: { tool: "delete_property", input: { id: prop.id } } };
    },
  }),
  defineTool({
    name: "delete_property",
    description: "Delete a custom task property and every value of it.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Delete this property and its values",
    gate: namedDelete("Delete this property and its values", (_ctx, { id: propId }: { id: string }) =>
      planName((s) => s.properties, propId, (p) => `Delete property ${q(p.name)} and every value of it`),
    ),
    input: id("id"),
    run: async (_ctx, { id: propId }) => ({ data: unwrap(await planning.deleteProperty(propId)), summary: "Deleted a property", inverse: null }),
  }),
  defineTool({
    name: "set_task_value",
    description: "Set a task's custom property value (null clears it).",
    group: "hydra",
    kind: "write",
    risk: (i) => (i.value === null ? "delete" : null),
    describe: () => "Clear this property value",
    gate: namedDelete(
      "Clear this property value",
      async (_ctx, { taskId, propertyId }: { taskId: string; propertyId: string; value: unknown }) => {
        const snap = await snapshot();
        const t = snap.tasks.find((x) => x.id === taskId);
        const p = snap.properties.find((x) => x.id === propertyId);
        return t && p ? `Clear ${q(p.name)} on task ${q(t.title)}` : null;
      },
      (i: { value: unknown }) => i.value === null,
    ),
    input: z.object({ taskId: uuid, propertyId: uuid, value: propertyValueSchema.nullable() }),
    run: async (_ctx, { taskId, propertyId, value }) => {
      const before = (await findTask(taskId)).values[propertyId] ?? null;
      return {
        data: unwrap(await planning.setTaskValue(taskId, propertyId, value)),
        summary: "Set a property value",
        inverse: { tool: "set_task_value", input: { taskId, propertyId, value: before } },
      };
    },
  }),
  defineTool({
    name: "move_task",
    description: "Move a task to a status by name or id (\"done\", \"In progress\"), at the end of it or after afterTaskId.",
    group: "hydra",
    kind: "write",
    input: z.object({ id: uuid, status: z.string().min(1).max(100), afterTaskId: uuid.optional() }),
    run: async (_ctx, { id: taskId, status, afterTaskId }) => {
      const snap = await snapshot();
      const before = snap.tasks.find((t) => t.id === taskId);
      if (!before) throw new ToolError("That task is gone.");
      const to = resolveStatus(snap, status);
      const rows = tasksInStatus(snap.tasks, to.id).filter((t) => t.id !== taskId);
      if (afterTaskId && !rows.some((t) => t.id === afterTaskId)) throw new ToolError(`That task is not in ${to.label}.`);
      const { position, renormalized } = placeAmong(rows, taskId, afterTaskId, null);
      const moved = to.id !== before.statusId;
      unwrap(await planning.setTaskPositions([...(renormalized ?? []).filter((u) => u.id !== taskId), { id: taskId, position, ...(moved ? { statusId: to.id } : {}) }]));
      return {
        data: { id: taskId, statusId: to.id, status: to.label, position },
        summary: `Moved ${before.title} to ${to.label}`,
        inverse: { tool: "update_task", input: { id: taskId, patch: { statusId: before.statusId, position: before.position } } },
      };
    },
  }),
  defineTool({
    name: "reorder_planning",
    description: "Set the order of statuses, properties, goals, or one property's options (propertyId): every id, first to last.",
    group: "hydra",
    kind: "write",
    bulk: (i) => i.ids.length,
    describe: (i) => `Reorder the ${i.kind}`,
    input: z.object({ kind: z.enum(["statuses", "properties", "goals", "options"]), ids: z.array(uuid).min(1).max(500), propertyId: uuid.optional() }),
    run: async (_ctx, { kind, ids, propertyId }) => {
      const snap = await snapshot();
      const order = (rows: readonly { id: string; position: number }[]) => [...rows].sort((a, b) => a.position - b.position).map((r) => r.id);
      let before: string[];
      if (kind === "statuses") {
        before = order(snap.statuses);
        unwrap(await planning.reorderStatuses(ids));
      } else if (kind === "properties") {
        before = order(snap.properties);
        unwrap(await planning.reorderProperties(ids));
      } else if (kind === "goals") {
        before = order(snap.goals);
        // setGoalPositions writes only the ids it gets: a partial list would leave the rest tied.
        if (ids.length !== before.length || new Set(ids).size !== ids.length || !ids.every((x) => before.includes(x))) {
          throw new ToolError(`Give every goal id once (${before.length}), first to last.`);
        }
        unwrap(await planning.setGoalPositions(ids.map((goalId, i) => ({ id: goalId, position: (i + 1) * STEP }))));
      } else {
        const prop = snap.properties.find((p) => p.id === propertyId);
        if (!prop) throw new ToolError("Options need the propertyId of their property.");
        before = order(prop.options);
        unwrap(await planning.reorderOptions(prop.id, ids));
      }
      return { data: { kind, ids }, summary: `Reordered ${kind}`, inverse: { tool: "reorder_planning", input: { kind, ids: before, ...(propertyId ? { propertyId } : {}) } } };
    },
  }),
  defineTool({
    name: "update_property",
    description: "Rename a custom task property, change its number format, or show it on the board or in the list.",
    group: "hydra",
    kind: "write",
    input: z.object({ id: uuid, patch: propertyPatchSchema }),
    run: async (_ctx, { id: propId, patch }) => {
      const before = (await snapshot()).properties.find((p) => p.id === propId);
      if (!before) throw new ToolError("That property is gone.");
      const prop = unwrap(await planning.updateProperty(propId, patch));
      return { data: prop, summary: `Changed property ${prop.name}`, inverse: { tool: "update_property", input: { id: propId, patch: pick(before, Object.keys(patch)) } } };
    },
  }),
  defineTool({
    name: "add_property_option",
    description: "Add an option (tag) to a select or multi-select property. Color is a #rrggbb hex.",
    group: "hydra",
    kind: "write",
    input: optionInputSchema
      .omit({ id: true })
      .extend({ id: uuid.optional(), afterOptionId: uuid.nullable().optional().describe("Place it after this option; null puts it first; left out, last") }),
    run: async (_ctx, { afterOptionId, ...input }) => {
      const option = unwrap(await planning.createOption({ ...input, id: input.id ?? randomUUID() }));
      if (afterOptionId !== undefined) {
        const prop = (await snapshot()).properties.find((p) => p.id === input.propertyId);
        const rest = [...(prop?.options ?? [])].sort((a, b) => a.position - b.position).map((o) => o.id).filter((x) => x !== option.id);
        // An after-option that is gone since: it stays last.
        const at = afterOptionId === null ? 0 : rest.indexOf(afterOptionId) + 1;
        if (afterOptionId === null || at > 0) unwrap(await planning.reorderOptions(input.propertyId, [...rest.slice(0, at), option.id, ...rest.slice(at)]));
      }
      return { data: option, summary: `Added option ${option.label}`, inverse: { tool: "delete_property_option", input: { id: option.id } } };
    },
  }),
  defineTool({
    name: "update_property_option",
    description: "Rename or recolor a select property's option (tag). Color is a #rrggbb hex.",
    group: "hydra",
    kind: "write",
    input: z.object({ id: uuid, patch: optionPatchSchema }),
    run: async (_ctx, { id: optionId, patch }) => {
      const before = findOption(await snapshot(), optionId).option;
      const option = unwrap(await planning.updateOption(optionId, patch));
      return { data: option, summary: `Changed option ${option.label}`, inverse: { tool: "update_property_option", input: { id: optionId, patch: pick(before, Object.keys(patch)) } } };
    },
  }),
  defineTool({
    name: "delete_property_option",
    description: "Delete a select property's option; tasks set to it lose that value.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Delete this option",
    gate: namedDelete("Delete this option", async (_ctx, { id: optionId }: { id: string }) => {
      const snap = await snapshot();
      const { option, propertyId } = findOption(snap, optionId);
      const name = snap.properties.find((p) => p.id === propertyId)!.name;
      return `Delete option ${q(option.label)} of ${q(name)}; tasks set to it lose that value`;
    }),
    input: id("id"),
    run: async (_ctx, { id: optionId }) => {
      const snap = await snapshot();
      const { option, propertyId } = findOption(snap, optionId);
      const order = [...snap.properties.find((p) => p.id === propertyId)!.options].sort((a, b) => a.position - b.position).map((o) => o.id);
      const i = order.indexOf(optionId);
      unwrap(await planning.deleteOption(optionId));
      return {
        data: { id: optionId },
        summary: `Deleted option ${option.label}`,
        // Undo brings the option back in its place; the task values it had are gone.
        inverse: { tool: "add_property_option", input: { id: option.id, propertyId, label: option.label, color: option.color, afterOptionId: i > 0 ? order[i - 1] : null } },
      };
    },
  }),
  defineTool({
    name: "update_goal_metric",
    description: "Change a goal metric's target, or its category (category_spend).",
    group: "hydra",
    kind: "write",
    input: z.object({ id: uuid, patch: goalMetricPatchSchema }),
    run: async (_ctx, { id: metricId, patch }) => {
      const before = (await snapshot()).goals.flatMap((g) => g.metrics).find((m) => m.id === metricId);
      if (!before) throw new ToolError("That goal metric is gone.");
      // Only category_spend has a category: setting one elsewhere could never be undone (a patch cannot set null).
      if (patch.param !== undefined && before.param === null) throw new ToolError("Only a category spend metric takes a category.");
      const metric = unwrap(await planning.updateGoalMetric(metricId, patch));
      return { data: metric, summary: "Changed a goal metric", inverse: { tool: "update_goal_metric", input: { id: metricId, patch: pick(before, Object.keys(patch)) } } };
    },
  }),
  defineTool({
    name: "update_goal_link",
    description: "Change a goal link's URL or title.",
    group: "hydra",
    kind: "write",
    input: z.object({ id: uuid, patch: goalLinkPatchSchema }),
    run: async (_ctx, { id: linkId, patch }) => {
      const before = (await snapshot()).goals.flatMap((g) => g.links).find((l) => l.id === linkId);
      if (!before) throw new ToolError("That goal link is gone.");
      const link = unwrap(await planning.updateGoalLink(linkId, patch));
      return { data: link, summary: "Changed a goal link", inverse: { tool: "update_goal_link", input: { id: linkId, patch: pick(before, Object.keys(patch)) } } };
    },
  }),
];

/**
 * Status name to status: ignores case, spaces and dashes. Short of an exact name, a status fits
 * when the name (3 characters or more) starts it or starts one of its words: "prog" fits
 * "In Progress", "in" and "ogress" fit nothing. A name that fits two asks which.
 */
export function resolveStatus(snap: Pick<PlanningSnapshot, "statuses">, name: string) {
  const byId = snap.statuses.find((s) => s.id === name);
  if (byId) return byId;
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const want = norm(name);
  const exact = snap.statuses.filter((s) => norm(s.label) === want);
  const fits = (label: string) => norm(label).startsWith(want) || label.toLowerCase().split(/[\s_-]+/).some((w) => w.startsWith(want));
  const found = exact.length ? exact : want.length >= 3 ? snap.statuses.filter((s) => fits(s.label)) : [];
  if (found.length === 1) return found[0];
  const labels = (found.length ? found : snap.statuses).map((s) => s.label);
  const list = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}` : (labels[0] ?? "none");
  throw new ToolError(found.length ? `Which status: ${list}?` : `No status named "${name}". The statuses are ${list}.`);
}

function findOption(snap: PlanningSnapshot, optionId: string) {
  for (const p of snap.properties) {
    const option = p.options.find((o) => o.id === optionId);
    if (option) return { option, propertyId: p.id };
  }
  throw new ToolError("That option is gone.");
}

// ── Dashboard layout ──────────────────────────────────────────────────────

const layoutTools: ToolDef[] = [
  defineTool({
    name: "save_layout",
    description: "Save a dashboard layout (desktop or phone). Send the updatedAt you read; a conflict returns the newer one.",
    group: "hydra",
    kind: "write",
    input: saveInputSchema,
    run: async (_ctx, input) => {
      const r = await saveLayout(input);
      if (!r.ok) throw new ToolError(r.reason === "conflict" ? "The layout changed. Read it again (get_layouts) and retry." : `Not saved: ${r.reason}`);
      return { data: r, summary: `Saved the ${input.breakpoint} dashboard`, inverse: null };
    },
  }),
  defineTool({
    name: "reset_layout",
    description: "Reset a dashboard layout to the default (the saved one is deleted).",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: (i) => `Reset the ${i.breakpoint} dashboard`,
    input: z.object({ breakpoint: z.enum(["desktop", "phone"]) }),
    run: async (_ctx, input) => {
      const r = await resetLayout(input);
      if (!r.ok) throw new ToolError(`Not reset: ${r.reason}`);
      return { data: r, summary: `Reset the ${input.breakpoint} dashboard`, inverse: null };
    },
  }),
];

export const HYDRA_TOOLS: ToolDef[] = [...reads, ...bankTools, ...ruleTools, ...ugcTools, ...planningTools, ...layoutTools];

