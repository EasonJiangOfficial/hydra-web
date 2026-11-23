import { z } from "zod";

import { formatDay } from "./dates";
import type { PlanningPropertyOptionRow, PlanningPropertyRow, PlanningTaskValueRow } from "./rows";
import { colorSchema, isoDateSchema, planningIdSchema } from "./schemas";

/**
 * Notion-style task properties (owner, 2026-11-04): owner-made fields on
 * every task. Pure, so the server actions, the repository and the UI share
 * one set of rules. "Empty" is always no value (no database row).
 * Design: handoffs/2026-11-04-planning-properties/DESIGN.md.
 */

export const PROPERTY_TYPES = [
  "select",
  "multi_select",
  "number",
  "text",
  "checkbox",
  "date",
  "url",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const NUMBER_FORMATS = ["number", "percent", "dollar"] as const;
export type NumberFormat = (typeof NUMBER_FORMATS)[number];

/** The database caps (0040_planning.sql). */
export const MAX_PROPERTIES = 50;
export const MAX_OPTIONS = 100;
const MAX_IDS = 30;

export interface PlanningOption {
  readonly id: string;
  readonly label: string;
  /** `#rrggbb`. */
  readonly color: string;
  readonly position: number;
}

export interface PlanningProperty {
  readonly id: string;
  readonly name: string;
  /** Fixed once made: delete and add again to change it. */
  readonly type: PropertyType;
  readonly numberFormat: NumberFormat;
  readonly position: number;
  /** Shown on Board cards / as a Table column. */
  readonly showOnBoard: boolean;
  readonly showInList: boolean;
  /** Select / multi-select only; in position order. */
  readonly options: readonly PlanningOption[];
}

/** A task's value of one property. No value = empty (never an empty value). */
export type PropertyValue =
  | { readonly type: "select"; readonly optionId: string }
  | { readonly type: "multi_select"; readonly optionIds: readonly string[] }
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "url"; readonly value: string }
  | { readonly type: "checkbox"; readonly value: true }
  | { readonly type: "date"; readonly value: string }

/** One property filter; every active filter must match (AND). */
export type PropertyFilter =
  | { readonly kind: "empty" }
  | { readonly kind: "not_empty" }
  /** select / multi_select: option ids. */
  | { readonly kind: "any_of"; readonly ids: readonly string[] }
  /** checkbox: true = checked, false = unchecked (no value). */
  | { readonly kind: "checked"; readonly value: boolean }
  /** text / url, case-insensitive. */
  | { readonly kind: "contains"; readonly text: string }
  /** number, inclusive. */
  | { readonly kind: "range"; readonly min?: number; readonly max?: number }
  /** date (YYYY-MM-DD), inclusive. */
  | {
      readonly kind: "date";
      readonly before?: string;
      readonly after?: string;
    };

// ── zod (client and server) ────────────────────────────────────────────

export const propertyNameSchema = z.string().trim().min(1).max(60);
export const optionLabelSchema = z.string().trim().min(1).max(60);
export const propertyTypeSchema = z.enum(PROPERTY_TYPES);
export const numberFormatSchema = z.enum(NUMBER_FORMATS);

const atLeastOneKey = (value: object): boolean => Object.keys(value).length > 0;
const unique = (ids: readonly string[]): boolean =>
  new Set(ids).size === ids.length;

/** The client picks the id (optimistic). Position is the server's: after the last. */
export const propertyInputSchema = z.strictObject({
  id: planningIdSchema,
  name: propertyNameSchema,
  type: propertyTypeSchema,
  numberFormat: numberFormatSchema.optional(),
  showOnBoard: z.boolean().optional(),
  showInList: z.boolean().optional(),
});
export type PropertyInput = z.infer<typeof propertyInputSchema>;

/** Never the type (fixed once made). */
export const propertyPatchSchema = z
  .strictObject({
    name: propertyNameSchema.optional(),
    numberFormat: numberFormatSchema.optional(),
    showOnBoard: z.boolean().optional(),
    showInList: z.boolean().optional(),
  })
  .refine(atLeastOneKey, "Empty patch");
export type PropertyPatch = z.infer<typeof propertyPatchSchema>;

export const optionInputSchema = z.strictObject({
  id: planningIdSchema,
  propertyId: planningIdSchema,
  label: optionLabelSchema,
  color: colorSchema,
});
export type OptionInput = z.infer<typeof optionInputSchema>;

export const optionPatchSchema = z
  .strictObject({
    label: optionLabelSchema.optional(),
    color: colorSchema.optional(),
  })
  .refine(atLeastOneKey, "Empty patch");
export type OptionPatch = z.infer<typeof optionPatchSchema>;

/** A full order: every id once. */
export const idOrderSchema = z
  .array(planningIdSchema)
  .min(1)
  .max(MAX_OPTIONS)
  .refine(unique, "Duplicate id");

const idListSchema = z
  .array(planningIdSchema)
  .max(MAX_IDS)
  .refine(unique, "Duplicate id");

/** A value to save, or null to clear it (the row is deleted). */
export const propertyValueSchema = z
  .discriminatedUnion("type", [
    z.strictObject({ type: z.literal("select"), optionId: planningIdSchema }),
    z.strictObject({
      type: z.literal("multi_select"),
      optionIds: idListSchema.min(1),
    }),
    z.strictObject({
      type: z.literal("number"),
      value: z.number().finite().gt(-1e12).lt(1e12),
    }),
    z.strictObject({
      type: z.literal("text"),
      value: z
        .string()
        .max(2000)
        .refine((s) => s.trim() !== "", "Empty text"),
    }),
    z.strictObject({
      type: z.literal("url"),
      value: z
        .string()
        .trim()
        .max(500)
        .pipe(z.url({ protocol: /^https?$/ })),
    }),
    z.strictObject({ type: z.literal("checkbox"), value: z.literal(true) }),
    z.strictObject({ type: z.literal("date"), value: isoDateSchema }),
  ])
  .nullable();

// ── rows <-> domain ────────────────────────────────────────────────────

const byOrder = (
  a: { readonly position: number; readonly created_at: string; id: string },
  b: { readonly position: number; readonly created_at: string; id: string },
): number =>
  a.position - b.position ||
  (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const toOption = (row: PlanningPropertyOptionRow): PlanningOption => ({
  id: row.id,
  label: row.label,
  color: row.color,
  position: row.position,
});

/** Options in position order, then created_at, then id. */
export const toProperty = (
  row: PlanningPropertyRow,
  options: readonly PlanningPropertyOptionRow[] = [],
): PlanningProperty => ({
  id: row.id,
  name: row.name,
  type: row.type,
  numberFormat: row.number_format,
  position: row.position,
  showOnBoard: row.show_on_board,
  showInList: row.show_in_list,
  options: [...options].sort(byOrder).map(toOption),
});

/** Properties in position order, then created_at, then id. */
export function sortPropertyRows<
  R extends { position: number; created_at: string; id: string },
>(rows: readonly R[]): R[] {
  return [...rows].sort(byOrder);
}

type ValueColumns = Omit<
  PlanningTaskValueRow,
  "task_id" | "property_id" | "updated_at"
>;

const NO_COLUMNS: ValueColumns = {
  text_value: null,
  number_value: null,
  date_value: null,
  bool_value: null,
  option_ids: null,
};

/** Every typed column, the others null: an upsert replaces the whole value. */
export function valueToColumns(value: PropertyValue): ValueColumns {
  switch (value.type) {
    case "select":
      return { ...NO_COLUMNS, option_ids: [value.optionId] };
    case "multi_select":
      return { ...NO_COLUMNS, option_ids: [...value.optionIds] };
    case "number":
      return { ...NO_COLUMNS, number_value: value.value };
    case "text":
    case "url":
      return { ...NO_COLUMNS, text_value: value.value };
    case "checkbox":
      return { ...NO_COLUMNS, bool_value: true };
    case "date":
      return { ...NO_COLUMNS, date_value: value.value };
  }
}

/** A stored row as the property's value; null when the row is not one (never shown). */
export function valueFromRow(
  type: PropertyType,
  row: ValueColumns,
): PropertyValue | null {
  const ids = row.option_ids ?? [];
  switch (type) {
    case "select":
      return ids.length === 1 ? { type, optionId: ids[0] } : null;
    case "multi_select":
      return ids.length > 0 ? { type, optionIds: ids } : null;
    case "number":
      return row.number_value === null
        ? null
        : { type, value: Number(row.number_value) };
    case "text":
    case "url":
      return row.text_value ? { type, value: row.text_value } : null;
    case "checkbox":
      return row.bool_value === true ? { type, value: true } : null;
    case "date":
      return row.date_value ? { type, value: row.date_value } : null;
  }
}

// ── display, filter, sort ──────────────────────────────────────────────

const plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const wholeDollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** 1,234.5 · 45% · $1,200 (cents only when there are some: $12.50). */
export function formatNumber(value: number, format: NumberFormat): string {
  if (format === "dollar")
    return (Number.isInteger(value) ? wholeDollars : dollars).format(value);
  const text = plain.format(value);
  return format === "percent" ? `${text}%` : text;
}

/** The host of a URL ("docs.example.com"), or the URL when it does not parse. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Option labels in the value's order; ids no longer on the property are skipped. */
export function optionLabels(
  property: PlanningProperty,
  ids: readonly string[],
): string[] {
  return ids.flatMap((id) => {
    const option = property.options.find((o) => o.id === id);
    return option ? [option.label] : [];
  });
}

/**
 * One line of text for a chip or a List cell: option labels, the number in
 * its format, the URL's host, "Yes" for a checked box, a short date.
 * `today` (YYYY-MM-DD) drops this year from a date. "" when nothing shows
 * (an option deleted meanwhile).
 */
export function formatPropertyValue(
  property: PlanningProperty,
  value: PropertyValue,
  today?: string,
): string {
  switch (value.type) {
    case "select":
      return optionLabels(property, [value.optionId]).join(", ");
    case "multi_select":
      return optionLabels(property, value.optionIds).join(", ");
    case "number":
      return formatNumber(value.value, property.numberFormat);
    case "text":
      return value.value;
    case "url":
      return urlHost(value.value);
    case "checkbox":
      return "Yes";
    case "date":
      return formatDay(value.value, today ?? value.value);
  }
}

/** Whether a task's value (undefined = empty) passes one filter. A filter with no bounds passes all. */
export function matchesPropertyFilter(
  value: PropertyValue | undefined,
  filter: PropertyFilter,
): boolean {
  switch (filter.kind) {
    case "empty":
      return value === undefined;
    case "not_empty":
      return value !== undefined;
    case "any_of": {
      if (filter.ids.length === 0) return true;
      const ids =
        value?.type === "select"
          ? [value.optionId]
          : value?.type === "multi_select"
            ? value.optionIds
            : [];
      return ids.some((id) => filter.ids.includes(id));
    }
    case "checked":
      return (value?.type === "checkbox") === filter.value;
    case "contains": {
      const needle = filter.text.trim().toLowerCase();
      if (!needle) return true;
      return (
        (value?.type === "text" || value?.type === "url") &&
        value.value.toLowerCase().includes(needle)
      );
    }
    case "range": {
      const { min, max } = filter;
      if (min === undefined && max === undefined) return true;
      return (
        value?.type === "number" &&
        (min === undefined || value.value >= min) &&
        (max === undefined || value.value <= max)
      );
    }
    case "date": {
      const { before, after } = filter;
      if (before === undefined && after === undefined) return true;
      return (
        value?.type === "date" &&
        (after === undefined || value.value >= after) &&
        (before === undefined || value.value <= before)
      );
    }
  }
}

const textOrder = (a: string, b: string): number =>
  a.localeCompare(b, "en", { sensitivity: "base" });

/** Element-wise, then the shorter first. */
function compareLists<T>(
  a: readonly T[],
  b: readonly T[],
  compare: (x: T, y: T) => number,
): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const c = compare(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/**
 * Sort order of two values of one property. Empty (undefined) sorts last in
 * BOTH directions. Select / multi-select follow the option order (a deleted
 * option after the rest).
 */
export function comparePropertyValues(
  property: PlanningProperty,
  a: PropertyValue | undefined,
  b: PropertyValue | undefined,
  dir: "asc" | "desc" = "asc",
): number {
  if (a === undefined || b === undefined) {
    return a === b ? 0 : a === undefined ? 1 : -1;
  }
  const sign = dir === "desc" ? -1 : 1;
  const rank = (id: string): number => {
    const i = property.options.findIndex((o) => o.id === id);
    return i < 0 ? Infinity : i;
  };
  const ranks = (v: PropertyValue): number[] =>
    v.type === "select"
      ? [rank(v.optionId)]
      : v.type === "multi_select"
        ? v.optionIds.map(rank).sort((x, y) => x - y)
        : [];
  let c = 0;
  if (a.type === "number" && b.type === "number") c = a.value - b.value;
  else if (
    (a.type === "text" || a.type === "url") &&
    (b.type === "text" || b.type === "url")
  )
    c = textOrder(a.value, b.value);
  else if (a.type === "date" && b.type === "date")
    c = a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  else c = compareLists(ranks(a), ranks(b), (x, y) => x - y);
  // Infinity - Infinity is NaN: two deleted options tie.
  return Number.isNaN(c) || c === 0 ? 0 : sign * c;
}
