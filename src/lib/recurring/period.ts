/**
 * How often a recurring series repeats, from its median gap in days (an int: a monthly bill is 30 or 31).
 * The same buckets as the Accounts "Every" column: a week, 2 weeks, a month, 3 months, 6 months, a year.
 * An odd gap falls back to 365 / gap.
 */
const BUCKETS: [days: number, slack: number, perYear: number][] = [
  [7, 1, 52],
  [14, 1, 26],
  [30.4, 3, 12],
  [91, 5, 4],
  [182, 6, 2],
  [365, 8, 1],
];

export function timesPerYear(gapDays: number): number {
  const hit = BUCKETS.find(([days, slack]) => Math.abs(gapDays - days) <= slack);
  return hit ? hit[2] : 365 / gapDays;
}

/** What one series costs (or pays) in a year and in an average month, in cents. */
export const perYearCents = (amountCents: number, gapDays: number) => Math.round(amountCents * timesPerYear(gapDays)) || 0;
export const perMonthCents = (amountCents: number, gapDays: number) => Math.round((amountCents * timesPerYear(gapDays)) / 12) || 0;
