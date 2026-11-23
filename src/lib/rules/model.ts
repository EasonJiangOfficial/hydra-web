import { z } from "zod";

/**
 * The rule model (from Actual Budget's, MIT): conditions on a transaction's fields, actions that
 * set its fields. Stored as jsonb in `rules.conditions` and `rules.actions` in exactly these shapes.
 * Text compares ignore case and surrounding spaces. "contains" is a plain substring, never a pattern.
 * Amount is signed cents: money in positive, money out negative.
 */

export const TEXT_FIELDS = ["name", "merchant", "note"] as const;
export const OPERATORS = [
  "contains",
  "is",
  "starts_with",
  "contains_any",
  "not_contains",
  "one_of",
  "between",
  "regex",
] as const;
export type Operator = (typeof OPERATORS)[number];

const text = z.string().trim().min(1).max(200);
const textList = z.array(text).min(1).max(50);
const cents = z.int().min(-1e13).max(1e13);
const id = z.guid();

/** Patterns stay short: the owner (or the agent) writes them, and they run on the server. */
const pattern = z
  .string()
  .min(1)
  .max(200)
  .refine((p) => compile(p) !== null, "That pattern is not valid");

const textField = z.enum(TEXT_FIELDS);

export const conditionSchema = z.union([
  z.object({ field: textField, op: z.enum(["contains", "is", "starts_with", "not_contains"]), value: text }),
  z.object({ field: textField, op: z.literal("regex"), value: pattern }),
  z.object({ field: textField, op: z.enum(["contains_any", "one_of"]), value: textList }),
  z.object({ field: z.literal("amount"), op: z.literal("is"), value: cents }),
  z.object({ field: z.literal("amount"), op: z.literal("one_of"), value: z.array(cents).min(1).max(50) }),
  z.object({
    field: z.literal("amount"),
    op: z.literal("between"),
    value: z.tuple([cents, cents]).refine(([lo, hi]) => lo <= hi, "The low amount must come first"),
  }),
  z.object({ field: z.literal("account"), op: z.literal("is"), value: id }),
  z.object({ field: z.literal("account"), op: z.literal("one_of"), value: z.array(id).min(1).max(50) }),
]);
export type Condition = z.infer<typeof conditionSchema>;

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_category"), categoryId: id }),
  z.object({ type: z.literal("set_entity"), entityId: id }),
  z.object({ type: z.literal("rename"), name: text }),
  z.object({ type: z.literal("set_tax_line"), taxLineId: id }),
  z.object({ type: z.literal("mark_transfer") }),
  z.object({ type: z.literal("mark_recurring"), recurringId: id }),
]);
export type Action = z.infer<typeof actionSchema>;

export const conditionsSchema = z.array(conditionSchema).min(1).max(20);
export const actionsSchema = z
  .array(actionSchema)
  .min(1)
  .max(6)
  .refine((a) => new Set(a.map((x) => x.type)).size === a.length, "Each action type at most once");

export interface Rule {
  id: string;
  position: number;
  conditions: Condition[];
  actions: Action[];
  enabled: boolean;
}

/** The transaction fields rules read and write (database column names). */
export interface RuleTarget {
  id: string;
  account_id: string;
  amount_cents: number;
  name: string;
  merchant: string | null;
  note: string | null;
  renamed: boolean;
  entity_id: string;
  /** The owner set the business by hand: rules never change it. */
  entity_manual?: boolean;
  category_id: string | null;
  category_source: "rule" | "manual" | "import" | "none";
  tax_line_id: string | null;
  is_transfer: boolean;
  recurring_id: string | null;
}

/** What a rule changes on one row. Only changed fields are present. */
export interface RulePatch {
  id: string;
  category_id?: string;
  entity_id?: string;
  name?: string;
  tax_line_id?: string;
  is_transfer?: true;
  recurring_id?: string;
}

/** A case-insensitive pattern, or null when it does not compile. */
export function compile(p: string): RegExp | null {
  try {
    return new RegExp(p, "i");
  } catch {
    return null;
  }
}
