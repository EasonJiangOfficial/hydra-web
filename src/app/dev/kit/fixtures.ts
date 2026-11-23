// Fixture data for /dev/kit. Numbers copy the live Main.dc.html board. Money is integer cents.

export const scopes = [
  { value: "all", label: "All" },
  { value: "personal", label: "Personal" },
  { value: "ugc", label: "UGC" },
];

export const scopesShort = [
  { value: "all", label: "All" },
  { value: "personal", label: "Me" },
  { value: "ugc", label: "UGC" },
];

export const ranges = [
  { value: "1w", label: "1W" },
  { value: "1m", label: "1M" },
  { value: "3m", label: "3M" },
  { value: "ytd", label: "YTD" },
  { value: "all", label: "All" },
];

const trendCents = [
  4410000, 4432000, 4425000, 4460000, 4448000, 4495000, 4512000, 4505000, 4540000, 4568000, 4561000, 4590000,
  4602000, 4644000, 4630000, 4671000, 4705000, 4698000, 4731000, 4752000, 4744000, 4779000, 4790000, 4821240,
];
export const trend = trendCents.map((value, i) => ({ label: i < 3 ? `Oct ${29 + i}` : `Nov ${i - 2}`, value }));

export const netWorth = { cents: 4821240, change: 210418, pct: "4.6%" };

export const cash = {
  total: 3184000,
  rows: [
    { name: "Checking", cents: 942055 },
    { name: "Savings", cents: 2241957 },
  ],
};

export const cards = {
  total: -231800,
  due: "Due in 6 days",
  rows: [
    { name: "Amex Gold", cents: 160410 },
    { name: "Sapphire", cents: 71462 },
  ],
};

export const month = [
  { label: "Income this month", cents: 648000, info: "Money in this month, before card bills are paid. Updated 2 hours ago." },
  { label: "Net after card bills", cents: 416100, info: "Income $6,480 minus card balances $2,318 owed now." },
  { label: "Spending", cents: 290500, pill: "+12%", info: "Spending this month across all accounts, transfers excluded. 12% above October." },
  { label: "Recurring", cents: 41300, unit: "a month", info: "Subscriptions and bills seen in at least two of the last three months." },
];

export const ugc = [
  { name: "Paid", cents: 268000 },
  { name: "Owed to you", cents: 126000 },
  { name: "Missed", cents: -42000, loss: true },
  { name: "Projected, 30 days", cents: 375000 },
];

const counts = [3, 3, 2, 0, 3, 4, 3, 1, 3, 3, 0, 2, 3, 3, 3, 3, 2, 3, 0, 3, 3, 3, 1, 3, 3, 3, 3, 3, 0, 0];
export const days = counts.map((c, i) => ({
  day: i + 1,
  date: `Nov ${i + 1}`,
  posted: i > 20 ? 0 : c,
  target: 3,
  future: i > 20,
  amountCents: c >= 3 ? c * 3000 : -(3 - c) * 3000,
}));

export const recent = [
  { name: "Wordwise payout", cat: "UGC income", cents: 142000 },
  { name: "Adobe Creative Cloud", cat: "Software", cents: -5999 },
  { name: "Uber Eats", cat: "Food", cents: -2740 },
  { name: "CapCut Pro", cat: "Software", cents: -999 },
  { name: "Target", cat: "Needs review", cents: -8412 },
];

export const goals = [
  { name: "Post 3 videos a day", value: 0.72, text: "65 / 90", info: "Videos posted this month against 3 a day. Needs 3.1 a day to finish." },
  { name: "$10k UGC revenue in December", value: 0.39, text: "$3.9k / $10k", info: "Paid plus owed UGC revenue. Needs $203 a day." },
  { name: "Net worth $60k", value: 0.8, text: "$48k / $60k", info: "Net worth across all accounts. Needs $1,180 a month at the current pace." },
];

export const comingUp = [
  { date: "Nov 27", name: "Amex Gold statement due", cents: 160410 },
  { date: "Dec 1", name: "Rent", cents: 145000 },
  { date: "Dec 5", name: "Wordwise payout", cents: 126000, signed: true },
];

export const months = [
  { label: "Jun", values: [510000, 248000] },
  { label: "Jul", values: [590000, 261000] },
  { label: "Aug", values: [470000, 289000] },
  { label: "Sep", values: [690000, 254000] },
  { label: "Oct", values: [730000, 277900] },
  { label: "Nov", values: [648000, 290500] },
];

export const spending = [
  { label: "Housing", value: 145000 },
  { label: "Food", value: 52000 },
  { label: "Software", value: 31000 },
  { label: "Shopping", value: 24500 },
  { label: "Other", value: 20000 },
  { label: "Transport", value: 18000 },
];

export const sankey = {
  nodes: [
    { name: "Wordwise (UGC)" },
    { name: "Brightleaf (UGC)" },
    { name: "Other income" },
    { name: "Income" },
    { name: "Savings", color: "var(--sankey-savings)" },
    { name: "Housing", color: "var(--sankey-housing)" },
    { name: "Taxes set aside", color: "var(--sankey-taxes)" },
    { name: "Food", color: "var(--sankey-food)" },
    { name: "Software", color: "var(--sankey-software)" },
    { name: "Shopping", color: "var(--sankey-shopping)" },
    { name: "Other", color: "var(--sankey-other)" },
    { name: "Transport", color: "var(--sankey-transport)" },
  ],
  links: [
    { source: 0, target: 3, value: 320000 },
    { source: 1, target: 3, value: 208000 },
    { source: 2, target: 3, value: 120000 },
    { source: 3, target: 4, value: 227500 },
    { source: 3, target: 5, value: 145000 },
    { source: 3, target: 6, value: 130000 },
    { source: 3, target: 7, value: 52000 },
    { source: 3, target: 8, value: 31000 },
    { source: 3, target: 9, value: 24500 },
    { source: 3, target: 10, value: 20000 },
    { source: 3, target: 11, value: 18000 },
  ],
};

export const transactions = [
  { date: "Nov 20", name: "Wordwise payout", cat: "UGC income", account: "Checking", cents: 142000 },
  { date: "Nov 19", name: "Adobe Creative Cloud", cat: "Software", account: "Amex Gold", cents: -5999 },
  { date: "Nov 19", name: "Uber Eats", cat: "Food", account: "Sapphire", cents: -2740 },
  { date: "Nov 18", name: "Target", cat: "Needs review", account: "Amex Gold", cents: -8412 },
];
