import type { Scope } from "@/components/shell/scope";
import { addDays, formatDay } from "@/lib/planning/dates";
import type { DashboardData, FlowMonth, NetWorthPoint, PostingDay } from "./types";

/** Fixture data for /dev/dashboard. The numbers copy Main.dc.html. Saturday, November 21, 2026. */
export const FIXTURE_TODAY = "2026-11-21";

const NET_NOW = 4_821_240;
const DEBTS = 231_800;

/** 400 days, oldest first, ending today at the wireframe's $48,212.40, rising about $70 a day. Real
 * balances for the last two weeks only (a new bank link): the days before are estimated. */
function series(): NetWorthPoint[] {
  return Array.from({ length: 400 }, (_, i) => {
    const ago = 399 - i;
    const netCents = NET_NOW - Math.round(ago * 7014 + ((ago * 37) % 11) * 900);
    return { day: addDays(FIXTURE_TODAY, -ago), netCents, assetsCents: netCents + DEBTS, debtsCents: DEBTS, estimated: ago > 14 };
  });
}

const counts = [3, 3, 2, 0, 3, 4, 3, 1, 3, 3, 0, 2, 3, 3, 3, 3, 2, 3, 0, 3, 3, 3, 1, 3, 3, 3, 3, 3, 0, 0];
const days: PostingDay[] = counts.map((c, i) => {
  const date = `2026-11-${String(i + 1).padStart(2, "0")}`;
  const future = date > FIXTURE_TODAY;
  return {
    day: i + 1,
    date,
    label: formatDay(date, FIXTURE_TODAY),
    posted: future ? 0 : c,
    target: 3,
    future,
    amountCents: future ? 0 : c >= 3 ? c * 3000 : -(3 - c) * 3000,
    // Two deals: Wordwise 2 a day, Brightleaf 1 a day. Brightleaf's video is the first one missed.
    lines: future ? undefined : [`Wordwise ${Math.min(c, 2)} of 2`, `Brightleaf ${Math.max(0, c - 2)} of 1`],
  };
});

/** The phone strip: the last 7 days to today. */
const week = days.filter((d) => d.date <= FIXTURE_TODAY).slice(-7);

/** Twelve months to November 2026 from whole dollars per month (the last one is November so far). */
function trend(income: readonly number[], spending: readonly number[]): FlowMonth[] {
  return income.map((d, i) => {
    const m = 12 + i;
    const month = `${2025 + Math.floor((m - 1) / 12)}-${String(((m - 1) % 12) + 1).padStart(2, "0")}-01`;
    return { month, incomeCents: d * 100, spendingCents: (spending[i] ?? 0) * 100 };
  });
}

const PERSONAL_IN = [5080, 5080, 5080, 5080, 5080, 5080, 5200, 5200, 5200, 5200, 5200, 2540];
const PERSONAL_OUT = [4120, 3980, 4310, 4050, 4420, 3890, 4210, 4600, 4180, 3950, 4380, 2285];
const UGC_IN = [1800, 2100, 2650, 2400, 3100, 3600, 3300, 4100, 4550, 5200, 4800, 3940];
const UGC_OUT = [380, 420, 510, 450, 600, 560, 700, 640, 720, 690, 810, 620];
const sum = (a: readonly number[], b: readonly number[]) => a.map((v, i) => v + (b[i] ?? 0));
const dollars = (rows: [string, number][]) => rows.map(([name, d]) => ({ name, cents: d * 100 }));

const goals = [
  { id: "goal-posts", title: "Post 3 videos a day", percent: 72, text: "65 / 90", info: "Posts per day\nNov 1 to Nov 30\nNeeds 3.1 a day" },
  {
    id: "goal-ugc",
    title: "$10k UGC revenue in December",
    percent: 39,
    text: "$3.9k / $10k",
    info: "UGC revenue\nDec 1 to Dec 31\nNeeds $153 a day",
  },
  { id: "goal-net", title: "Net worth $60k", percent: 80, text: "$48.2k / $60k", info: "Net worth\nNov 1 to Dec 31\nNeeds $196 a day" },
];

const ALL: DashboardData = {
  scope: "all",
  scopeName: "All",
  today: FIXTURE_TODAY,
  hasAccounts: true,
  balancesAsOf: "Nov 21",
  netWorth: series(),
  cash: {
    totalCents: 3_184_000,
    rows: [
      { id: "acct-checking", name: "Checking", cents: 942_055 },
      { id: "acct-savings", name: "Savings", cents: 2_241_957 },
    ],
  },
  cards: {
    totalCents: DEBTS,
    rows: [
      { id: "acct-amex", name: "Amex Gold", owedCents: 160_410, statementCents: 160_410, dueOn: "2026-11-27", limitCents: 1_300_000 },
      { id: "acct-sapphire", name: "Sapphire", owedCents: 71_462, statementCents: 71_462, dueOn: "2026-12-02", limitCents: 800_000 },
    ],
  },
  month: {
    incomeCents: 648_000,
    incomeCount: 4,
    netAfterCardsCents: 416_200,
    cardBalanceCents: DEBTS,
    spendingCents: 290_500,
    spendingPrevCents: 259_400,
    prev: { incomeCents: 612_000, spendingCents: 259_400 },
    recurringCents: 41_300,
    recurringCount: 6,
  },
  trend: trend(sum(PERSONAL_IN, UGC_IN), sum(PERSONAL_OUT, UGC_OUT)),
  categories: dollars([["Housing", 1450], ["Food", 520], ["Software", 310], ["Transport", 240], ["Shopping", 210], ["Health", 95], ["Fees", 80]]),
  refundCents: 0,
  ugc: { earnedCents: 394_000, paidCents: 268_000, owedCents: 126_000, missedCents: 42_000, projectedCents: 375_000, deals: 2, missedViewDays: [] },
  posting: { days, week, streak: 5 },
  recent: [
    { id: "tx-1", name: "Wordwise payout", category: "UGC income", cents: 142_000 },
    { id: "tx-2", name: "Adobe Creative Cloud", category: "Software", categoryColor: "#4f7cb8", cents: -5_999 },
    { id: "tx-3", name: "Uber Eats", category: "Food", categoryColor: "#4b8a8c", cents: -2_740 },
    { id: "tx-4", name: "CapCut Pro", category: "Software", categoryColor: "#4f7cb8", cents: -999 },
    { id: "tx-5", name: "Target", category: null, cents: -8_412 },
  ],
  goals,
  comingUp: [
    { key: "card-amex", date: "2026-11-27", name: "Amex Gold statement due", cents: 160_410, href: "/accounts?account=acct-amex" },
    { key: "rent", date: "2026-12-01", name: "Rent", cents: 145_000 },
    { key: "payout", date: "2026-12-05", name: "Wordwise payout", cents: 126_000, signed: true, href: "/ugc" },
  ],
};

const EMPTY: DashboardData = {
  scope: "all",
  scopeName: "All",
  today: FIXTURE_TODAY,
  hasAccounts: false,
  balancesAsOf: null,
  netWorth: [],
  cash: { totalCents: 0, rows: [] },
  cards: { totalCents: 0, rows: [] },
  month: {
    incomeCents: 0,
    incomeCount: 0,
    netAfterCardsCents: 0,
    cardBalanceCents: 0,
    spendingCents: 0,
    spendingPrevCents: null,
    prev: { incomeCents: 0, spendingCents: 0 },
    recurringCents: 0,
    recurringCount: 0,
  },
  trend: trend(Array(12).fill(0), Array(12).fill(0)),
  categories: [],
  refundCents: 0,
  ugc: { earnedCents: 0, paidCents: 0, owedCents: 0, missedCents: 0, projectedCents: 0, deals: 0, missedViewDays: [] },
  posting: null,
  recent: [],
  goals: [],
  comingUp: [],
};

/**
 * A business added in Settings (`?added=on` lists it in the switch): its transactions are tagged to it, its card
 * and bank account still belong to Personal, so it has income and expenses but no accounts of its own.
 */
export const FIXTURE_BUSINESS = "studio-co";

/**
 * The loaded board for a scope. Personal has no UGC; the UGC scope holds the UGC half of the money; Studio Co
 * has money but no accounts; any other slug (a business with nothing tagged to it yet) has no rows and no goals,
 * only the rent coming up.
 */
export function fixtureData(scope: Scope): DashboardData {
  if (scope === "all") return ALL;
  if (scope === "personal") {
    return {
      ...ALL,
      scope,
      scopeName: "Personal",
      ugc: null,
      posting: null,
      month: { ...ALL.month, incomeCents: 254_000, incomeCount: 1, netAfterCardsCents: 22_200, spendingCents: 228_500, spendingPrevCents: 211_000, prev: { incomeCents: 254_000, spendingCents: 211_000 } },
      trend: trend(PERSONAL_IN, PERSONAL_OUT),
      categories: dollars([["Housing", 1450], ["Food", 430], ["Transport", 200], ["Shopping", 150], ["Health", 55]]),
      comingUp: ALL.comingUp.filter((c) => c.key !== "payout"),
    };
  }
  if (scope === "ugc") {
    return {
      ...ALL,
      scope,
      scopeName: "UGC",
      month: { ...ALL.month, incomeCents: 394_000, incomeCount: 3, netAfterCardsCents: 162_200, spendingCents: 62_000, spendingPrevCents: 48_400, prev: { incomeCents: 358_000, spendingCents: 48_400 } },
      trend: trend(UGC_IN, UGC_OUT),
      categories: dollars([["Software", 310], ["Equipment", 180], ["Food", 90], ["Fees", 40]]),
    };
  }
  const none = {
    ...EMPTY,
    scope,
    comingUp: ALL.comingUp.filter((c) => c.key === "rent"),
    ugc: null,
  } satisfies DashboardData;
  if (scope !== FIXTURE_BUSINESS) return { ...none, scopeName: scope === "ugm" ? "UGM LLC" : scope };
  return {
    ...none,
    scopeName: "Studio Co",
    goals: ALL.goals,
    month: { ...EMPTY.month, incomeCents: 420_000, incomeCount: 3, netAfterCardsCents: 420_000, spendingCents: 118_000, spendingPrevCents: 112_000, prev: { incomeCents: 380_000, spendingCents: 112_000 }, recurringCents: 24_000, recurringCount: 2 },
    trend: trend([0, 0, 0, 0, 0, 1200, 2400, 3100, 2800, 3900, 4600, 4200], [0, 0, 0, 0, 0, 650, 900, 1100, 980, 1250, 1400, 1180]),
    // A $30 refund pushed Supplies below zero, so it is off the list: the listed categories are $30 above Expenses.
    categories: dollars([["Contractors", 450], ["Software", 240], ["Ads", 210], ["Equipment", 140], ["Travel", 85], ["Meals", 35], ["Fees", 50]]),
    refundCents: 3_000,
    recent: [
      { id: "tx-s1", name: "Northwind invoice", category: "Client income", cents: 180_000 },
      { id: "tx-s2", name: "Upwork contractor", category: "Contractors", cents: -45_000 },
      { id: "tx-s3", name: "Meta ads", category: "Ads", cents: -21_000 },
      { id: "tx-s4", name: "Figma", category: "Software", categoryColor: "#4f7cb8", cents: -4_500 },
    ],
  };
}

/** `?state=views`: Grokbot read only some posts on Nov 19 and none on Nov 20 (the missed-day warning). */
export function withViewGaps(data: DashboardData): DashboardData {
  if (!data.ugc) return data;
  return {
    ...data,
    ugc: {
      ...data.ugc,
      missedViewDays: [
        { day: "2026-11-19", needing: 9, read: 6 },
        { day: "2026-11-20", needing: 9, read: 0 },
      ],
    },
  };
}

/** No accounts, no deals, no goals: every card shows its one plain line. */
export const fixtureEmpty = (): DashboardData => EMPTY;
