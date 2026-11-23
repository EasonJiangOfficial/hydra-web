import { compile, type Action, type Condition, type Rule, type RulePatch, type RuleTarget } from "./model";

/**
 * The rule matcher. Pure: no database, no clock.
 * - Rules run in position order; the first enabled rule whose conditions ALL match wins.
 * - A row the owner categorized by hand (category_source 'manual') is never touched.
 * - A business the owner picked by hand (entity_manual) is never changed.
 * - A rename never replaces an earlier rename (the owner's or a rule's).
 */

const norm = (s: string | null) => (s ?? "").trim().toLowerCase();

export function matchCondition(c: Condition, t: Pick<RuleTarget, "account_id" | "amount_cents" | "name" | "merchant" | "note">): boolean {
  if (c.field === "amount") {
    const a = t.amount_cents;
    if (c.op === "is") return a === c.value;
    if (c.op === "one_of") return c.value.includes(a);
    return a >= c.value[0] && a <= c.value[1];
  }
  if (c.field === "account") return c.op === "is" ? t.account_id === c.value : c.value.includes(t.account_id);

  const v = norm(t[c.field]);
  switch (c.op) {
    case "contains":
      return v.includes(norm(c.value));
    case "not_contains":
      return !v.includes(norm(c.value));
    case "is":
      return v === norm(c.value);
    case "starts_with":
      return v.startsWith(norm(c.value));
    case "contains_any":
      return c.value.some((x) => v.includes(norm(x)));
    case "one_of":
      return c.value.some((x) => v === norm(x));
    case "regex":
      return compile(c.value)?.test((t[c.field] ?? "").trim()) ?? false;
  }
}

const byPosition = (a: Rule, b: Rule) => a.position - b.position;

/** The rule that wins for this row, or null. */
export function firstMatch(rules: readonly Rule[], t: RuleTarget): Rule | null {
  return [...rules].sort(byPosition).find((r) => r.enabled && r.conditions.every((c) => matchCondition(c, t))) ?? null;
}

/** The changes `actions` make to `t`, without the ones that change nothing. Null when nothing changes. */
export function patchFor(actions: readonly Action[], t: RuleTarget): RulePatch | null {
  const p: RulePatch = { id: t.id };
  for (const a of actions) {
    if (a.type === "set_category" && t.category_id !== a.categoryId) p.category_id = a.categoryId;
    if (a.type === "set_entity" && !t.entity_manual && t.entity_id !== a.entityId) p.entity_id = a.entityId;
    if (a.type === "rename" && !t.renamed && t.name !== a.name) p.name = a.name;
    if (a.type === "set_tax_line" && t.tax_line_id !== a.taxLineId) p.tax_line_id = a.taxLineId;
    if (a.type === "mark_transfer" && !t.is_transfer) p.is_transfer = true;
    if (a.type === "mark_recurring" && t.recurring_id !== a.recurringId) p.recurring_id = a.recurringId;
  }
  return Object.keys(p).length > 1 ? p : null;
}

/** What a rule run writes for these rows: one patch per row that changes. Manual rows are skipped. */
export function planRun(rules: readonly Rule[], rows: readonly RuleTarget[]): { patch: RulePatch; ruleId: string }[] {
  const out: { patch: RulePatch; ruleId: string }[] = [];
  for (const t of rows) {
    if (t.category_source === "manual") continue;
    const rule = firstMatch(rules, t);
    const patch = rule && patchFor(rule.actions, t);
    if (rule && patch) out.push({ patch, ruleId: rule.id });
  }
  return out;
}

/**
 * The rule to offer after the owner picks a category by hand: the merchant (or, without one, the
 * exact name) sets that category. Null when the rules already give this row that category.
 */
export function suggestRule(
  rules: readonly Rule[],
  t: RuleTarget,
  categoryId: string,
): { conditions: Condition[]; actions: Action[] } | null {
  if (firstMatch(rules, t)?.actions.some((a) => a.type === "set_category" && a.categoryId === categoryId)) return null;
  const merchant = t.merchant?.trim();
  return {
    conditions: [merchant ? { field: "merchant", op: "is", value: merchant } : { field: "name", op: "is", value: t.name.trim() }],
    actions: [{ type: "set_category", categoryId }],
  };
}
