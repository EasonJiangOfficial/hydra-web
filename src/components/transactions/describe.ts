import { formatMoney } from "@/components/kit/money";
import { firstMatch } from "@/lib/rules/match";
import type { Action, Condition, RulePatch, RuleTarget } from "@/lib/rules/model";
import type { Lookups, RowFilters, StoredRule, TxRow } from "./types";

/** Pure helpers for the Transactions page: plain-words rule text, the rule behind a category, the table window. */

const byId = <T extends { id: string }>(list: readonly T[], id: string | null | undefined) =>
  id ? list.find((x) => x.id === id) : undefined;

export const categoryName = (l: Lookups, id: string | null) => byId(l.categories, id)?.name ?? null;
export const entityName = (l: Lookups, id: string) => byId(l.entities, id)?.name ?? "Unknown";
export const accountName = (l: Lookups, id: string) => {
  const a = byId(l.accounts, id);
  return a ? (a.nickname ?? a.name) + (a.mask ? ` ${a.mask}` : "") : "Unknown";
};

const OP_WORDS: Record<string, string> = {
  contains: "contains",
  is: "is",
  starts_with: "starts with",
  contains_any: "contains any of",
  not_contains: "does not contain",
  one_of: "is one of",
  between: "is between",
  regex: "matches",
};
const FIELD_WORDS: Record<string, string> = { name: "Name", merchant: "Merchant", note: "Note", amount: "Amount", account: "Account" };

export const opWord = (op: string) => OP_WORDS[op] ?? op;
export const fieldWord = (field: string) => FIELD_WORDS[field] ?? field;

const dollars = (cents: number) => formatMoney(cents, { whole: Number.isInteger(cents / 100) });

export function describeCondition(c: Condition, l: Lookups): string {
  const head = `${fieldWord(c.field)} ${opWord(c.op)}`;
  if (c.field === "amount") {
    if (c.op === "between") return `${head} ${dollars(c.value[0])} and ${dollars(c.value[1])}`;
    return `${head} ${c.op === "one_of" ? c.value.map(dollars).join(", ") : dollars(c.value)}`;
  }
  if (c.field === "account") {
    const names = (c.op === "is" ? [c.value] : c.value).map((id) => accountName(l, id));
    return `${head} ${names.join(", ")}`;
  }
  return `${head} ${Array.isArray(c.value) ? c.value.map((v) => `“${v}”`).join(", ") : `“${c.value}”`}`;
}

export function describeAction(a: Action, l: Lookups): string {
  switch (a.type) {
    case "set_category":
      return `Category ${categoryName(l, a.categoryId) ?? "gone"}`;
    case "set_entity":
      return `Business ${entityName(l, a.entityId)}`;
    case "rename":
      return `Rename to “${a.name}”`;
    case "set_tax_line": {
      const t = byId(l.taxLines, a.taxLineId);
      return `Tax line ${t ? `${t.code} ${t.name}` : "gone"}`;
    }
    case "mark_transfer":
      return "Mark as transfer";
    case "mark_recurring":
      return `Recurring ${byId(l.recurring, a.recurringId)?.name ?? "gone"}`;
  }
}

export const describeConditions = (cs: readonly Condition[], l: Lookups) => cs.map((c) => describeCondition(c, l)).join(" and ");
export const describeActions = (as: readonly Action[], l: Lookups) => as.map((a) => describeAction(a, l)).join(", ");

export const toTarget = (t: TxRow): RuleTarget => ({
  id: t.id,
  account_id: t.account_id,
  amount_cents: t.amount_cents,
  name: t.name,
  merchant: t.merchant,
  note: t.note,
  renamed: t.renamed,
  entity_id: t.entity_id,
  category_id: t.category_id,
  category_source: t.category_source,
  tax_line_id: t.tax_line_id,
  is_transfer: t.is_transfer,
  recurring_id: t.recurring_id,
});

/** Who set this row's category: the text of the category pill's hover card. */
export function categoryReason(t: TxRow, rules: readonly StoredRule[], l: Lookups): { text: string; rule: StoredRule | null } {
  if (t.category_source === "manual") return { text: "Set by you", rule: null };
  if (t.category_source === "import") return { text: "Came with the import", rule: null };
  if (t.category_source === "none" || !t.category_id) return { text: "No category yet", rule: null };
  const hit = firstMatch(
    rules.filter((r) => r.actions.some((a) => a.type === "set_category" && a.categoryId === t.category_id)),
    toTarget(t),
  );
  const rule = hit ? (rules.find((r) => r.id === hit.id) ?? null) : null;
  return rule
    ? { text: `Set by a rule\n${describeConditions(rule.conditions, l)}`, rule }
    : { text: "Set by a rule that has since changed", rule: null };
}

/** The rule to start from when the owner makes one from a row: its merchant (or name), and its category if it has one. */
export function seedFromRow(t: TxRow): { conditions: Condition[]; actions: Action[] } {
  const merchant = t.merchant?.trim();
  return {
    conditions: [merchant ? { field: "merchant", op: "is", value: merchant } : { field: "name", op: "is", value: t.name.trim() }],
    actions: t.category_id ? [{ type: "set_category", categoryId: t.category_id }] : [],
  };
}

/** The Schedule C line a row counts toward: its own, else its category's (or its parent's) for its business. */
export function effectiveTaxLineId(t: TxRow, l: Lookups): string | null {
  if (t.tax_line_id) return t.tax_line_id;
  const cat = byId(l.categories, t.category_id);
  if (!cat) return null;
  const find = (cid: string) => l.categoryTaxLines.find((m) => m.category_id === cid && m.entity_id === t.entity_id)?.tax_line_id ?? null;
  return find(cat.id) ?? (cat.parent_id ? find(cat.parent_id) : null);
}

/** The category and its subcategories. */
export const categoryFamily = (l: Lookups, id: string) => [id, ...l.categories.filter((c) => c.parent_id === id).map((c) => c.id)];

/** Rows to draw for a scroll position: a window with `overscan` rows on each side. */
export function visibleWindow(scrollTop: number, viewport: number, rowH: number, count: number, overscan = 6) {
  const first = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + viewport) / rowH) + overscan);
  return { first, last: Math.max(first, last) };
}

/** "-12.5" or "$1,200" to signed integer cents; null when it is not an amount. */
export function parseDollars(text: string): number | null {
  const t = text.replace(/[$,\s]/g, "");
  if (!/^[+-]?\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export const centsToText = (cents: number) => (cents / 100).toFixed(2).replace(/\.00$/, "");

export function dateLabel(iso: string, now = new Date()): string {
  const [y, m, d] = iso.split("-").map(Number);
  const text = new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(y === now.getFullYear() ? {} : { year: "numeric" }) });
  return text;
}

/** "Nov 14, 2026". */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Does a row belong in a view? The database filters the live list; this is for rows edited in place and for the fixture. */
export function matchesFilters(t: TxRow, f: RowFilters): boolean {
  if (f.hidden) {
    if (!t.hidden) return false;
  } else if (f.review) {
    if (t.category_id || t.is_transfer || t.hidden) return false;
  } else if (t.hidden) return false;
  if (f.accountId && t.account_id !== f.accountId) return false;
  if (f.entityId && t.entity_id !== f.entityId) return false;
  if (f.categoryIds && !(t.category_id && f.categoryIds.includes(t.category_id))) return false;
  if (f.from && t.posted_on < f.from) return false;
  if (f.to && t.posted_on > f.to) return false;
  const q = f.q?.trim().toLowerCase();
  if (q && ![t.name, t.merchant, t.raw_description, t.note].some((v) => v?.toLowerCase().includes(q))) return false;
  return true;
}

/** What a rule would change on a previewed row, in a few words. */
export function describePatch(p: RulePatch, before: { category_id: string | null }, l: Lookups): string {
  const parts: string[] = [];
  if (p.category_id) parts.push(`${categoryName(l, before.category_id) ?? "No category"} to ${categoryName(l, p.category_id) ?? "gone"}`);
  if (p.entity_id) parts.push(`Business ${entityName(l, p.entity_id)}`);
  if (p.name) parts.push(`Rename to ${p.name}`);
  if (p.tax_line_id) parts.push("Tax line");
  if (p.is_transfer) parts.push("Transfer");
  if (p.recurring_id) parts.push(`Recurring ${l.recurring.find((r) => r.id === p.recurring_id)?.name ?? ""}`.trim());
  return parts.join(", ");
}

