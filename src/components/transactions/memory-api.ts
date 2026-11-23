import { findTransferSuggestions, pairKey, type AutoPairRow } from "@/lib/ledger/pairing";
import { actionsSchema, conditionsSchema, type Action, type Condition } from "@/lib/rules/model";
import { matchCondition, patchFor, planRun, suggestRule } from "@/lib/rules/match";
import { matchesFilters, toTarget } from "./describe";
import { FIXTURE_TODAY, fixtureLookups, fixtureRows, fixtureRules } from "./fixture-data";
import { PAGE_SIZE, type Lookups, type StoredRule, type TxApi, type TxRow } from "./types";

/**
 * The fixture's engine: the same TxApi as the live page, on rows in memory. The rule matcher is the
 * real one (src/lib/rules/match.ts), so the preview, the "set by a rule" hover and the rule offer
 * behave exactly as they do live. A reload starts over.
 */

const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = <C extends string>(code: C, message: string) => ({ ok: false as const, error: { code, message } });

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export interface MemoryApi {
  api: TxApi;
  lookups: Lookups;
  rules: StoredRule[];
  /** Rows as they stand now (the tests read them). */
  rows(): TxRow[];
}

export function createMemoryApi(opts: { rows?: TxRow[]; rules?: StoredRule[]; lookups?: Lookups; today?: string; delayMs?: number } = {}): MemoryApi {
  const today = opts.today ?? FIXTURE_TODAY;
  const lookups = opts.lookups ?? fixtureLookups();
  let rows = opts.rows ?? fixtureRows();
  let rules = opts.rules ?? fixtureRules();
  const payments = new Map<string, string>();
  const rejected = new Set<string>();
  let ruleSeq = 450000; // above the fixture's rule ids (400001...)
  const find = (id: string) => rows.find((r) => r.id === id);
  const patch = (id: string, p: Partial<TxRow>) => {
    rows = rows.map((r) => (r.id === id ? { ...r, ...p } : r));
  };
  const wait = () => (opts.delayMs ? new Promise((r) => setTimeout(r, opts.delayMs)) : Promise.resolve());
  const sorted = () => [...rules].sort((a, b) => a.position - b.position);

  const run = (from?: string) => {
    const scope = rows.filter((r) => !from || r.posted_on >= from);
    const plan = planRun(
      sorted().filter((r) => r.enabled),
      scope.map(toTarget),
    );
    for (const { patch: p } of plan) {
      const { id, ...rest } = p;
      patch(id, { ...rest, ...(rest.category_id ? { category_source: "rule" as const } : {}), ...(rest.name ? { renamed: true } : {}) });
    }
    return { checked: scope.length, changed: plan.length };
  };

  const api: TxApi = {
    async listRows(f, offset) {
      await wait();
      const all = rows.filter((r) => matchesFilters(r, f));
      return { rows: all.slice(offset, offset + PAGE_SIZE), total: all.length };
    },
    async getRow(id) {
      return find(id) ?? null;
    },
    async reviewCount(entityId) {
      return rows.filter((r) => matchesFilters(r, { review: true, entityId })).length;
    },
    async pairCandidates(id) {
      const t = find(id);
      if (!t || t.transfer_pair_id) return [];
      return rows
        .filter(
          (r) =>
            r.id !== id &&
            !r.transfer_pair_id &&
            r.account_id !== t.account_id &&
            r.amount_cents === -t.amount_cents &&
            Math.abs(Date.parse(r.posted_on) - Date.parse(t.posted_on)) <= 5 * 86_400_000,
        )
        .slice(0, 20);
    },
    async dealPayment(id) {
      const deal = payments.get(id);
      return deal ? { deal_id: deal } : null;
    },
    async transferSuggestions() {
      await wait();
      const kind = (accountId: string): AutoPairRow["account_kind"] => {
        const a = lookups.accounts.find((x) => x.id === accountId);
        return a ? (/card/i.test(a.name) ? "card" : "cash") : null;
      };
      const candidates = rows.map((r) => ({
        ...r,
        account_kind: kind(r.account_id),
        category_kind: lookups.categories.find((c) => c.id === r.category_id)?.kind ?? null,
        deal_matched: payments.has(r.id),
      }));
      return findTransferSuggestions(candidates, rejected).map((p) => ({ out: find(p.a)!, into: find(p.b)! }));
    },
    async rejectTransfer({ aId, bId }) {
      if (!find(aId) || !find(bId) || aId === bId) return fail("invalid_input", "Pick two transactions");
      rejected.add(pairKey(aId, bId));
      return ok({ rejected: true as const });
    },

    async setCategory(input) {
      const t = find(input.transactionId);
      if (!t) return fail("not_found", "transaction: not found");
      const before = { category_id: t.category_id, category_source: t.category_source, entity_id: t.entity_id };
      patch(t.id, { category_id: input.categoryId, category_source: "manual", ...(input.entityId ? { entity_id: input.entityId } : {}) });
      return ok({ transactionId: t.id, before, suggestion: input.categoryId ? suggestRule(sorted(), toTarget(t), input.categoryId) : null });
    },
    async editTransaction(input) {
      const t = find(input.transactionId);
      if (!t) return fail("not_found", "transaction: not found");
      const p: Partial<TxRow> = {};
      if (input.name !== undefined) Object.assign(p, { name: input.name, renamed: true });
      if (input.note !== undefined) p.note = input.note || null;
      if (input.hidden !== undefined) p.hidden = input.hidden;
      if (input.entityId !== undefined) p.entity_id = input.entityId;
      if (!Object.keys(p).length) return fail("invalid_input", "Nothing to change");
      const before = Object.fromEntries(Object.keys(p).map((k) => [k, t[k as keyof TxRow]]));
      patch(t.id, p);
      return ok({ transactionId: t.id, before });
    },
    async updateCategory(input) {
      const c = lookups.categories.find((x) => x.id === input.id);
      if (!c) return fail("not_found", "category: not found");
      if (input.color !== undefined && input.color !== null && !/^#[0-9a-f]{6}$/i.test(input.color)) return fail("invalid_input", "color: not a hex color");
      const before = { ...c };
      if (input.name !== undefined) c.name = input.name;
      if (input.color !== undefined) c.color = input.color;
      return ok({ category: { ...c }, before });
    },
    async deleteManualTransaction({ transactionId }) {
      const t = find(transactionId);
      if (!t) return fail("not_found", "transaction: not found");
      if (t.source !== "manual") return fail("not_manual", "Only a manual transaction can be deleted");
      if (t.transfer_pair_id) return fail("paired", "Unpair this transfer first");
      const deal = payments.get(t.id);
      payments.delete(t.id);
      rows = rows.filter((r) => r.id !== t.id);
      const { account_id, posted_on, amount_cents, name, note, entity_id } = t;
      return ok({
        transactionId,
        before: { account_id, posted_on, amount_cents, name, note, entity_id },
        dealPayment: deal ? { id: `memory-${t.id}`, dealId: deal } : null,
      });
    },
    async mapCategoryTaxLine(input) {
      const list = lookups.categoryTaxLines;
      const i = list.findIndex((m) => m.category_id === input.categoryId && m.entity_id === input.entityId);
      const before = i >= 0 ? list[i].tax_line_id : null;
      if (i >= 0) list.splice(i, 1);
      if (input.taxLineId) list.push({ category_id: input.categoryId, entity_id: input.entityId, tax_line_id: input.taxLineId });
      return ok({ before });
    },
    async pairTransfers({ aId, bId }) {
      const [a, b] = [find(aId), find(bId)];
      if (!a || !b || a.account_id === b.account_id || Math.sign(a.amount_cents) === Math.sign(b.amount_cents) || a.transfer_pair_id || b.transfer_pair_id)
        return fail("rejected", "These two cannot be paired: same account, same sign, or one is already paired");
      patch(a.id, { is_transfer: true, transfer_pair_id: b.id });
      patch(b.id, { is_transfer: true, transfer_pair_id: a.id });
      return ok({ paired: true as const });
    },
    async unpairTransfer({ transactionId }) {
      const t = find(transactionId);
      if (!t) return fail("not_found", "unpair: not found");
      const ids = [t.id, t.transfer_pair_id].filter((x): x is string => !!x);
      for (const id of ids) patch(id, { is_transfer: false, transfer_pair_id: null, category_source: "manual" });
      return ok({ changed: ids.length });
    },
    async confirmRecurring({ id }) {
      const s = lookups.recurring.find((r) => r.id === id);
      if (!s) return fail("not_found", "recurring: not found");
      const before = s.status;
      s.status = "confirmed";
      return ok({ before });
    },
    async dismissRecurring({ id }) {
      const s = lookups.recurring.find((r) => r.id === id);
      if (!s) return fail("not_found", "recurring: not found");
      const before = s.status;
      s.status = "dismissed";
      const linked = rows.filter((r) => r.recurring_id === id);
      for (const r of linked) patch(r.id, { recurring_id: null });
      return ok({ before, unlinked: linked.length });
    },
    async matchPayment(input) {
      if (payments.has(input.transactionId)) return fail("conflict", "This deposit is already matched to a deal");
      payments.set(input.transactionId, input.dealId);
      return ok({ id: input.transactionId, deal_id: input.dealId, transaction_id: input.transactionId, amount_cents: input.amountCents, paid_on: input.paidOn, created_at: today });
    },
    async unmatchPayment({ transactionId }) {
      if (!payments.delete(transactionId)) return fail("not_found", "This deposit is not matched");
      return ok({ transactionId });
    },

    async previewRule(input) {
      await wait();
      const parsedC = conditionsSchema.safeParse(input.conditions);
      const parsedA = actionsSchema.safeParse(input.actions);
      if (!parsedC.success || !parsedA.success) return fail("invalid_input", "That rule is not valid");
      const since = addDays(today, -(input.days ?? 90));
      const recent = rows.filter((r) => r.posted_on >= since).slice(0, 1000);
      const matched = recent.filter((t) => parsedC.data.every((c) => matchCondition(c, t)));
      return ok({
        checked: recent.length,
        matched: matched.length,
        rows: matched.slice(0, 200).map((t) => ({
          id: t.id,
          posted_on: t.posted_on,
          name: t.name,
          merchant: t.merchant,
          amount_cents: t.amount_cents,
          category_id: t.category_id,
          manual: t.category_source === "manual",
          patch: t.category_source === "manual" ? null : patchFor(parsedA.data, toTarget(t)),
        })),
      });
    },
    async createRule(input) {
      const c = conditionsSchema.safeParse(input.conditions);
      const a = actionsSchema.safeParse(input.actions);
      if (!c.success || !a.success) return fail("invalid_input", "That rule is not valid");
      const positions = rules.map((r) => r.position);
      const position = positions.length ? (input.first ? Math.min(...positions) - 1 : Math.max(...positions) + 1) : 0;
      const rule: StoredRule = {
        id: `00000000-0000-4000-8000-${String(++ruleSeq).padStart(12, "0")}`,
        position,
        conditions: c.data as Condition[],
        actions: a.data as Action[],
        enabled: input.enabled ?? true,
        created_at: today,
        updated_at: today,
      };
      rules = [...rules, rule];
      return ok({ rule, applied: input.applyFrom ? run(input.applyFrom) : null });
    },
    async updateRule(input) {
      const before = rules.find((r) => r.id === input.id);
      if (!before) return fail("not_found", "rule: not found");
      const rule: StoredRule = {
        ...before,
        ...(input.conditions ? { conditions: input.conditions } : {}),
        ...(input.actions ? { actions: input.actions } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      };
      rules = rules.map((r) => (r.id === input.id ? rule : r));
      return ok({ rule, before, applied: input.applyFrom ? run(input.applyFrom) : null });
    },
    async deleteRule({ id }) {
      const before = rules.find((r) => r.id === id);
      if (!before) return fail("not_found", "delete rule: not found");
      rules = rules.filter((r) => r.id !== id);
      return ok({ before });
    },
    async reorderRules({ ids }) {
      if (ids.length !== rules.length || ids.some((id) => !rules.some((r) => r.id === id))) return fail("conflict", "The rules changed. Reload and try again");
      rules = ids.map((id, position) => ({ ...rules.find((r) => r.id === id)!, position }));
      return ok({ ids });
    },
    async applyRules(input) {
      return ok(run("from" in input ? input.from : undefined));
    },
  };

  return { api, lookups, get rules() { return sorted(); }, rows: () => rows };
}
