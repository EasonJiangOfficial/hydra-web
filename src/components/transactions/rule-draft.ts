import { z } from "zod";

import { actionSchema, actionsSchema, conditionSchema, conditionsSchema, type Action, type Condition, type Operator } from "@/lib/rules/model";
import { centsToText, parseDollars } from "./describe";

/**
 * The rule editor's working copy: plain strings that may be half-typed. `buildRule` turns it into
 * the engine's own Condition and Action shapes (checked by the engine's own schemas) or says what to fix.
 */

export type Field = "name" | "merchant" | "note" | "amount" | "account";
export const FIELDS: { value: Field; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "merchant", label: "Merchant" },
  { value: "note", label: "Note" },
  { value: "amount", label: "Amount" },
  { value: "account", label: "Account" },
];

const TEXT_OPS: Operator[] = ["contains", "is", "starts_with", "contains_any", "not_contains", "one_of", "regex"];
export const OPS_BY_FIELD: Record<Field, Operator[]> = {
  name: TEXT_OPS,
  merchant: TEXT_OPS,
  note: TEXT_OPS,
  amount: ["is", "one_of", "between"],
  account: ["is", "one_of"],
};
export const OP_LABEL: Record<Operator, string> = {
  contains: "contains",
  is: "is exactly",
  starts_with: "starts with",
  contains_any: "contains any of",
  not_contains: "does not contain",
  one_of: "is one of",
  between: "is between",
  regex: "matches pattern",
};

export interface DraftCondition {
  key: string;
  field: Field;
  op: Operator;
  text: string;
  text2: string;
  ids: string[];
}

export const ACTION_TYPES: { value: Action["type"]; label: string }[] = [
  { value: "set_category", label: "Set category" },
  { value: "set_entity", label: "Set business" },
  { value: "rename", label: "Rename" },
  { value: "set_tax_line", label: "Set tax line" },
  { value: "mark_transfer", label: "Mark as transfer" },
  { value: "mark_recurring", label: "Mark as recurring" },
];

export interface DraftAction {
  key: string;
  type: Action["type"];
  /** An id, or the new name for a rename. */
  ref: string;
}

let seq = 0;
export const newKey = () => `k${++seq}`;

export const blankCondition = (): DraftCondition => ({ key: newKey(), field: "name", op: "contains", text: "", text2: "", ids: [] });

const list = (text: string) => text.split(",").map((x) => x.trim()).filter(Boolean);

export function draftFromCondition(c: Condition): DraftCondition {
  const base = { key: newKey(), field: c.field, op: c.op, text: "", text2: "", ids: [] as string[] } satisfies DraftCondition;
  if (c.field === "amount") {
    if (c.op === "between") return { ...base, text: centsToText(c.value[0]), text2: centsToText(c.value[1]) };
    return { ...base, text: Array.isArray(c.value) ? c.value.map(centsToText).join(", ") : centsToText(c.value) };
  }
  if (c.field === "account") return { ...base, ids: Array.isArray(c.value) ? c.value : [c.value] };
  return { ...base, text: Array.isArray(c.value) ? c.value.join(", ") : c.value };
}

export function draftFromAction(a: Action): DraftAction {
  const ref =
    a.type === "set_category" ? a.categoryId
    : a.type === "set_entity" ? a.entityId
    : a.type === "set_tax_line" ? a.taxLineId
    : a.type === "mark_recurring" ? a.recurringId
    : a.type === "rename" ? a.name
    : "";
  return { key: newKey(), type: a.type, ref };
}

const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? "Check this condition";

export function conditionFromDraft(d: DraftCondition): { ok: true; value: Condition } | { ok: false; message: string } {
  let value: unknown;
  if (d.field === "amount") {
    if (d.op === "between") {
      const [lo, hi] = [parseDollars(d.text), parseDollars(d.text2)];
      if (lo === null || hi === null) return { ok: false, message: "Amounts are numbers like -12.50 (money out is negative)" };
      value = [lo, hi];
    } else {
      const cents = (d.op === "one_of" ? list(d.text) : [d.text]).map(parseDollars);
      if (!cents.length || cents.some((c) => c === null)) return { ok: false, message: "Amounts are numbers like -12.50 (money out is negative)" };
      value = d.op === "one_of" ? cents : cents[0];
    }
  } else if (d.field === "account") {
    if (!d.ids.length) return { ok: false, message: "Pick an account" };
    value = d.op === "is" ? d.ids[0] : d.ids;
  } else if (d.op === "contains_any" || d.op === "one_of") {
    value = list(d.text);
  } else {
    value = d.text.trim();
  }
  const parsed = conditionSchema.safeParse({ field: d.field, op: d.op, value });
  if (parsed.success) return { ok: true, value: parsed.data };
  if (d.op === "regex" && d.text.trim()) return { ok: false, message: "That pattern is not valid" };
  return { ok: false, message: d.field === "account" || d.field === "amount" ? firstIssue(parsed.error) : `Add text for the ${d.field} condition` };
}

export function actionFromDraft(d: DraftAction): { ok: true; value: Action } | { ok: false; message: string } {
  const body =
    d.type === "set_category" ? { categoryId: d.ref }
    : d.type === "set_entity" ? { entityId: d.ref }
    : d.type === "set_tax_line" ? { taxLineId: d.ref }
    : d.type === "mark_recurring" ? { recurringId: d.ref }
    : d.type === "rename" ? { name: d.ref }
    : {};
  const parsed = actionSchema.safeParse({ type: d.type, ...body });
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, message: d.type === "rename" ? "Type the new name" : "Pick a value for each action" };
}

/** The rule, or the first thing to fix. */
export function buildRule(
  conditions: readonly DraftCondition[],
  actions: readonly DraftAction[],
): { ok: true; conditions: Condition[]; actions: Action[] } | { ok: false; message: string } {
  if (!conditions.length) return { ok: false, message: "Add a condition" };
  if (!actions.length) return { ok: false, message: "Add an action" };
  const cs: Condition[] = [];
  for (const d of conditions) {
    const r = conditionFromDraft(d);
    if (!r.ok) return r;
    cs.push(r.value);
  }
  const as: Action[] = [];
  for (const d of actions) {
    const r = actionFromDraft(d);
    if (!r.ok) return r;
    as.push(r.value);
  }
  const c = conditionsSchema.safeParse(cs);
  if (!c.success) return { ok: false, message: firstIssue(c.error) };
  const a = actionsSchema.safeParse(as);
  if (!a.success) return { ok: false, message: firstIssue(a.error) };
  return { ok: true, conditions: c.data, actions: a.data };
}
