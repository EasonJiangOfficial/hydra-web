/**
 * Income and spending for a set of transactions. Pure. DESIGN.md section 9.
 * - Transfers and card payments (is_transfer, or a 'transfer' category) count as neither.
 * - A category's kind decides where a row counts, not its sign: a refund (money in) in an expense
 *   category reduces that category's spending; a reversal in an income category reduces income.
 * - Uncategorized rows count by sign: money in is income, money out is spending.
 * - Hidden rows count as nothing.
 */

export type CategoryKind = "income" | "expense" | "transfer";

export interface FlowRow {
  amount_cents: number;
  category_id: string | null;
  is_transfer: boolean;
  hidden: boolean;
}

export interface FlowTotals {
  incomeCents: number;
  spendingCents: number;
  /** Per category and kind. Income is positive; spending is positive (a net refund makes it negative). */
  categories: { categoryId: string | null; kind: "income" | "expense"; cents: number }[];
}

export function flowTotals(rows: readonly FlowRow[], kinds: ReadonlyMap<string, CategoryKind>): FlowTotals {
  const byKey = new Map<string, { categoryId: string | null; kind: "income" | "expense"; cents: number }>();
  let incomeCents = 0;
  let spendingCents = 0;
  for (const r of rows) {
    if (r.hidden || r.is_transfer) continue;
    const declared = r.category_id ? kinds.get(r.category_id) : undefined;
    if (declared === "transfer") continue;
    const kind = declared ?? (r.amount_cents >= 0 ? "income" : "expense");
    const cents = kind === "income" ? r.amount_cents : -r.amount_cents;
    if (kind === "income") incomeCents += cents;
    else spendingCents += cents;
    const key = `${r.category_id ?? ""}:${kind}`;
    const entry = byKey.get(key) ?? { categoryId: r.category_id, kind, cents: 0 };
    entry.cents += cents;
    byKey.set(key, entry);
  }
  return { incomeCents, spendingCents, categories: [...byKey.values()] };
}
