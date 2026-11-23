import { addDays, daysUntil } from "@/lib/planning/dates";

/**
 * Recurring detection. Pure; `today` is injected (the owner's zone). DESIGN.md section 9.
 * A series is rows with the same name key, a steady gap and a steady amount:
 * - Name key: the name lowercased with digits and punctuation dropped ("NETFLIX.COM 1234" -> "netflix com").
 *   Only rows with the sign of the latest row count, so a refund does not break a charge series.
 * - Steady gap: at least 3 rows; every gap within max(3, 20%) days of the median gap (5 days or more).
 * - Steady amount, either fixed or variable:
 *   fixed: runs of one exact amount, each 2 rows or more except the first and the last. The last
 *     step between runs is the price change; it is flagged while it is the newest row.
 *   variable: every amount within 20% of the median amount (a utility bill). Never a price change.
 * - A series with no row for two gaps has ended and is not suggested.
 */

export interface RecurringRow {
  id: string;
  name: string;
  posted_on: string;
  amount_cents: number;
  pending: boolean;
  is_transfer: boolean;
  hidden: boolean;
}

export interface PriceChange {
  from_cents: number;
  to_cents: number;
  on: string;
}

export interface DetectedSeries {
  name_key: string;
  name: string;
  average_amount_cents: number;
  gap_days: number;
  last_seen_on: string;
  next_expected_on: string;
  last_price_change: PriceChange | null;
  transaction_ids: string[];
}

const MIN_ROWS = 3;
const MIN_GAP_DAYS = 5;
const VARIABLE_BAND = 0.2;

export const nameKey = (name: string) => name.toLowerCase().replace(/[^\p{L}]+/gu, " ").trim();

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Steady amount check on absolute cents. Null when the amounts are not steady. */
function amountShape(amounts: number[]): { averageCents: number; change: { from: number; to: number; index: number } | null } | null {
  const runs: { value: number; start: number; count: number }[] = [];
  amounts.forEach((value, i) => {
    const last = runs.at(-1);
    if (last && last.value === value) last.count++;
    else runs.push({ value, start: i, count: 1 });
  });
  const fixed = runs.every((r, i) => r.count >= 2 || i === 0 || i === runs.length - 1);
  if (fixed) {
    const [prev, last] = runs.length > 1 ? runs.slice(-2) : [null, runs[0]];
    return { averageCents: last.value, change: prev ? { from: prev.value, to: last.value, index: last.start } : null };
  }
  const m = median(amounts);
  if (amounts.some((a) => Math.abs(a - m) > m * VARIABLE_BAND)) return null;
  return { averageCents: Math.round(amounts.reduce((s, a) => s + a, 0) / amounts.length), change: null };
}

export function detectRecurring(rows: readonly RecurringRow[], today: string): DetectedSeries[] {
  const groups = new Map<string, RecurringRow[]>();
  for (const r of rows) {
    if (r.pending || r.is_transfer || r.hidden || r.amount_cents === 0) continue;
    const key = nameKey(r.name);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }

  const found: DetectedSeries[] = [];
  for (const [key, group] of groups) {
    group.sort((a, b) => a.posted_on.localeCompare(b.posted_on) || a.id.localeCompare(b.id));
    const sign = Math.sign(group.at(-1)!.amount_cents);
    const series = group.filter((r) => Math.sign(r.amount_cents) === sign);
    if (series.length < MIN_ROWS) continue;

    const gaps = series.slice(1).map((r, i) => daysUntil(r.posted_on, series[i].posted_on));
    const gap = Math.round(median(gaps));
    const tolerance = Math.max(3, Math.round(gap * 0.2));
    if (gap < MIN_GAP_DAYS || gaps.some((g) => Math.abs(g - gap) > tolerance)) continue;

    const last = series.at(-1)!;
    if (daysUntil(today, last.posted_on) > 2 * gap) continue;

    const shape = amountShape(series.map((r) => Math.abs(r.amount_cents)));
    if (!shape) continue;

    found.push({
      name_key: key,
      name: last.name,
      average_amount_cents: sign * shape.averageCents,
      gap_days: gap,
      last_seen_on: last.posted_on,
      next_expected_on: addDays(last.posted_on, gap),
      last_price_change: shape.change
        ? { from_cents: sign * shape.change.from, to_cents: sign * shape.change.to, on: series[shape.change.index].posted_on }
        : null,
      transaction_ids: series.map((r) => r.id),
    });
  }
  return found;
}

/** A price change is flagged while the row that changed the price is the newest one. */
export const priceChangeFlagged = (r: { last_seen_on: string; last_price_change: PriceChange | null }) =>
  r.last_price_change?.on === r.last_seen_on;
