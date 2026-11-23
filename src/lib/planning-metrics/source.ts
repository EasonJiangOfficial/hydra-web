/** An inclusive span of owner's days (yyyy-mm-dd). */
export interface DayRange {
  readonly from: string;
  readonly to: string;
}

export interface PostingDay {
  readonly date: string;
  /** Counted videos posted that day, all deals. */
  readonly posted: number;
  /** The day's posting target, all deals. 0 is a day off. */
  readonly target: number;
}

export interface SpendRow {
  readonly categoryId: string | null;
  readonly name: string;
  readonly cents: number;
}

/**
 * Where the metric resolvers get their numbers. The live one (live-source.ts) reads the U5 report
 * functions and the U1 UGC queries; tests and the fixture pass plain data. Money is integer cents.
 */
export interface MetricSource {
  /** Assets minus debts on `asOf`, or null when no balance is stored. */
  netWorthCents(asOf: string): Promise<number | null>;
  /** Income before card bills inside the range. */
  incomeCents(range: DayRange): Promise<number>;
  /** Spending per top-level category inside the range, transfers and card payments left out. */
  spending(range: DayRange): Promise<{ totalCents: number; rows: readonly SpendRow[] }>;
  /** UGC earned inside the range. */
  ugcEarnedCents(range: DayRange): Promise<number>;
  /** One entry per day of the range, oldest first. */
  postingDays(range: DayRange): Promise<readonly PostingDay[]>;
  /** Counted videos posted inside the range and their payable views. */
  views(range: DayRange, timeZone: string): Promise<{ posts: number; views: number }>;
}
