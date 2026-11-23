import type { Scope } from "@/components/shell/scope";
import type { ViewGapDay } from "@/lib/ugc/view-gaps";

/**
 * Everything the Dashboard cards draw. Plain data (it crosses from the server page to the client
 * cards), money in integer cents, days as YYYY-MM-DD in the owner's zone. `src/app/(app)/(home)/load.ts`
 * builds it from the database; `fixture.ts` builds it for /dev/dashboard.
 */

/** `estimated`: walked back from transactions, not a real balance (the hover says so). */
export type NetWorthPoint = { day: string; netCents: number; assetsCents: number; debtsCents: number; estimated?: boolean };

export type CashRow = { id: string; name: string; cents: number };

export type CardRow = {
  id: string;
  name: string;
  /** What is owed now, positive. */
  owedCents: number;
  statementCents: number | null;
  dueOn: string | null;
  limitCents: number | null;
};

export type PostingDay = {
  day: number;
  /** YYYY-MM-DD. */
  date: string;
  /** "Nov 18". */
  label: string;
  posted: number;
  target: number;
  future: boolean;
  /** Missed (negative) wins over earned (positive). */
  amountCents: number;
  /** Hover lines per deal when the day has more than one ("Wordwise 0 of 2"). */
  lines?: string[];
};

/** `categoryColor`: the category's label color (its own, else its parent's), for the dot before it. */
export type RecentTx = { id: string; name: string; category: string | null; categoryColor?: string | null; cents: number };

export type GoalRow = {
  id: string;
  title: string;
  /** 0 to 100. */
  percent: number;
  /** "$3.9k / $10k". */
  text: string;
  /** Hover text: metric, window, pace needed per day. */
  info: string;
};

export type ComingUpRow = {
  key: string;
  /** YYYY-MM-DD. */
  date: string;
  name: string;
  cents: number | null;
  /** Show a plus on a positive amount (money coming in). */
  signed?: boolean;
  href?: string;
};

/** One month of the scope's money: income and expenses (reports_monthly_trend). */
export type FlowMonth = { month: string; incomeCents: number; spendingCents: number };

export type DashboardData = {
  scope: Scope;
  /** What the switch calls the scope: "All", "Personal", "Studio Co". */
  scopeName: string;
  /** The owner's today. */
  today: string;
  hasAccounts: boolean;
  /** "Nov 21": the newest balance the figures use. */
  balancesAsOf: string | null;
  /** Oldest first. The range switch slices it. */
  netWorth: NetWorthPoint[];
  cash: { totalCents: number; rows: CashRow[] };
  cards: { totalCents: number; rows: CardRow[] };
  month: {
    incomeCents: number;
    incomeCount: number;
    netAfterCardsCents: number;
    cardBalanceCents: number;
    spendingCents: number;
    /** Same days of last month; null when that month had no spending. */
    spendingPrevCents: number | null;
    /** The same days of last month (prevMonthSpan): what the income strip's hovers compare with. */
    prev: { incomeCents: number; spendingCents: number };
    recurringCents: number;
    recurringCount: number;
  };
  /** Twelve months ending with this one, oldest first. `month` is its first day, YYYY-MM-DD. */
  trend: FlowMonth[];
  /** This month's spending per top-level category, largest first (spendingByCategory). */
  categories: { name: string; cents: number }[];
  /** Refunds that pushed a category below zero: the listed categories less this is the Expenses figure. */
  refundCents: number;
  /** Null: UGC is not part of this scope. */
  ugc: {
    earnedCents: number;
    paidCents: number;
    owedCents: number;
    missedCents: number;
    projectedCents: number;
    deals: number;
    /** Days with open posts left without a view reading (the missed-day warning). */
    missedViewDays: ViewGapDay[];
  } | null;
  /** `days`: this month. `week`: the last 7 days to today (the phone's strip), across a month start. */
  posting: { days: PostingDay[]; week: PostingDay[]; streak: number } | null;
  recent: RecentTx[];
  goals: GoalRow[];
  comingUp: ComingUpRow[];
};
