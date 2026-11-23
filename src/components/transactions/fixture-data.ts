import type { Action, Condition } from "@/lib/rules/model";
import type { CategoryRow, RecurringSeriesRow, TaxLineRow } from "@/lib/rules/queries";
import type { AccountOption, EntityOption, Lookups, StoredRule, TxRow } from "./types";

/**
 * Fixture data for /dev/transactions and the tests: a few thousand deterministic rows, the real rule
 * shapes and a small chart of categories. No randomness: the same rows on every load.
 */

export const FIXTURE_TODAY = "2026-11-21";

const uid = (group: number, n: number) => `00000000-0000-4000-8000-${String(group * 100000 + n).padStart(12, "0")}`;
export const ids = {
  entity: (n: number) => uid(3, n),
  account: (n: number) => uid(2, n),
  category: (n: number) => uid(1, n),
  rule: (n: number) => uid(4, n),
  recurring: (n: number) => uid(5, n),
  taxLine: (n: number) => uid(6, n),
  deal: (n: number) => uid(7, n),
  tx: (n: number) => uid(9, n),
};

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const entities: EntityOption[] = [
  { id: ids.entity(1), slug: "personal", name: "Personal", kind: "personal" },
  { id: ids.entity(2), slug: "ugc", name: "UGC", kind: "business" },
  { id: ids.entity(3), slug: "ugm", name: "UGM LLC", kind: "business" },
];
const [PERSONAL, UGC] = [ids.entity(1), ids.entity(2)];

const accounts: AccountOption[] = [
  { id: ids.account(1), name: "Everyday Checking", nickname: null, mask: "4821", institution: "Chase", entity_id: PERSONAL },
  { id: ids.account(2), name: "Sapphire Card", nickname: "Visa", mask: "9034", institution: "Chase", entity_id: PERSONAL },
  { id: ids.account(3), name: "Business Checking", nickname: "Business", mask: "1177", institution: "Mercury", entity_id: UGC },
  { id: ids.account(4), name: "Business Card", nickname: "Biz card", mask: "5520", institution: "Mercury", entity_id: UGC },
];

type Cat = [n: number, name: string, kind: CategoryRow["kind"], entity: string | null, parent: number | null];
const CATS: Cat[] = [
  [1, "Brand deals", "income", UGC, null],
  [2, "Other income", "income", null, null],
  [10, "Advertising", "expense", UGC, null],
  [11, "Software and apps", "expense", UGC, null],
  [12, "Equipment", "expense", UGC, null],
  [13, "Contract editors", "expense", UGC, null],
  [14, "Platform and payment fees", "expense", UGC, null],
  [15, "Business meals", "expense", UGC, null],
  [16, "Props and products", "expense", UGC, null],
  [20, "Housing", "expense", PERSONAL, null],
  [21, "Rent", "expense", PERSONAL, 20],
  [22, "Utilities", "expense", PERSONAL, 20],
  [30, "Food", "expense", PERSONAL, null],
  [31, "Groceries", "expense", PERSONAL, 30],
  [32, "Dining out", "expense", PERSONAL, 30],
  [33, "Coffee", "expense", PERSONAL, 30],
  [40, "Transportation", "expense", PERSONAL, null],
  [41, "Gas", "expense", PERSONAL, 40],
  [42, "Rideshare and transit", "expense", PERSONAL, 40],
  [50, "Shopping", "expense", PERSONAL, null],
  [51, "Clothing", "expense", PERSONAL, 50],
  [52, "Electronics", "expense", PERSONAL, 50],
  [60, "Subscriptions", "expense", PERSONAL, null],
];
const categories: CategoryRow[] = CATS.map(([n, name, kind, entity_id, p]) => ({
  id: ids.category(n),
  name,
  parent_id: p ? ids.category(p) : null,
  kind,
  entity_id,
  color: null,
  archived: false,
}));

const taxLines: TaxLineRow[] = [
  ["8", "Advertising"],
  ["10", "Commissions and fees"],
  ["11", "Contract labor"],
  ["18", "Office expense"],
  ["22", "Supplies"],
  ["24b", "Deductible meals"],
].map(([code, name], i) => ({ id: ids.taxLine(i + 1), schedule: "C", part: "II", code, name, position: i + 1 }));

const categoryTaxLines = [
  [10, 1],
  [14, 2],
  [13, 3],
  [11, 4],
  [16, 5],
  [15, 6],
].map(([c, t]) => ({ category_id: ids.category(c), entity_id: UGC, tax_line_id: ids.taxLine(t) }));

const recurring: RecurringSeriesRow[] = [
  ["Adobe Creative Cloud", 6999, 30],
  ["Netflix", 1549, 30],
  ["Spotify", 1199, 30],
  ["CapCut Pro", 1999, 30],
].map(([name, cents, gap], i) => ({
  id: ids.recurring(i + 1),
  name_key: String(name).toLowerCase(),
  name: String(name),
  average_amount_cents: -Number(cents),
  gap_days: Number(gap),
  last_seen_on: "2026-11-05",
  next_expected_on: "2026-12-05",
  status: i === 3 ? "suggested" : "confirmed",
  last_price_change: null,
  price_change_flagged: false,
}));

const deals = [
  { id: ids.deal(1), name: "Wordwise" },
  { id: ids.deal(2), name: "Brightleaf" },
  { id: ids.deal(3), name: "Canvasly" },
];

/** [name, category n, entity, low cents, high cents, account, rule number or 0]. Rows with a rule get it as their category source. */
type Merchant = [string, number, string, number, number, number, number];
const MERCHANTS: Merchant[] = [
  ["Adobe Creative Cloud", 11, UGC, 6999, 6999, 4, 1],
  ["CapCut Pro", 11, UGC, 1999, 1999, 4, 1],
  ["Meta Ads", 10, UGC, 2500, 18000, 4, 2],
  ["TikTok Ads", 10, UGC, 2000, 12000, 4, 2],
  ["B&H Photo", 12, UGC, 4900, 89900, 4, 0],
  ["Upwork Escrow", 13, UGC, 15000, 60000, 3, 3],
  ["Stripe Fee", 14, UGC, 300, 1900, 3, 0],
  ["Staples", 16, UGC, 1200, 8900, 4, 0],
  ["Blue Bottle Coffee", 33, PERSONAL, 450, 1200, 2, 4],
  ["Starbucks", 33, PERSONAL, 450, 1400, 2, 4],
  ["Trader Joe's", 31, PERSONAL, 2400, 14500, 2, 5],
  ["Whole Foods", 31, PERSONAL, 3200, 21000, 2, 5],
  ["Chipotle", 32, PERSONAL, 1100, 2800, 2, 0],
  ["Sweetgreen", 32, PERSONAL, 1400, 2600, 2, 0],
  ["Uber", 42, PERSONAL, 900, 4200, 2, 6],
  ["Lyft", 42, PERSONAL, 800, 3800, 2, 6],
  ["Shell", 41, PERSONAL, 3500, 7200, 2, 0],
  ["Zara", 51, PERSONAL, 3900, 14900, 2, 0],
  ["Apple Store", 52, PERSONAL, 2900, 129900, 2, 0],
  ["Netflix", 60, PERSONAL, 1549, 1549, 2, 7],
  ["Spotify", 60, PERSONAL, 1199, 1199, 2, 7],
  ["Con Edison", 22, PERSONAL, 6000, 14000, 1, 0],
  ["Amazon", 52, PERSONAL, 1200, 24000, 2, 0],
  ["Venmo Cashout", 0, PERSONAL, 2000, 25000, 1, 0],
  ["Corner Deli", 32, PERSONAL, 600, 1800, 1, 0],
  ["Etsy", 16, UGC, 1500, 9000, 4, 0],
];

const rule = (n: number, position: number, conditions: Condition[], actions: Action[], enabled = true): StoredRule => ({
  id: ids.rule(n),
  position,
  conditions,
  actions,
  enabled,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});
const cat = (n: number): Action => ({ type: "set_category", categoryId: ids.category(n) });

export function fixtureRules(): StoredRule[] {
  return [
    rule(1, 0, [{ field: "name", op: "contains_any", value: ["Adobe", "CapCut"] }], [cat(11), { type: "set_entity", entityId: UGC }]),
    rule(2, 1, [{ field: "name", op: "contains_any", value: ["Meta Ads", "TikTok Ads"] }], [cat(10)]),
    rule(3, 2, [{ field: "name", op: "starts_with", value: "Upwork" }], [cat(13)]),
    rule(4, 3, [{ field: "name", op: "contains_any", value: ["Starbucks", "Blue Bottle"] }], [cat(33)]),
    rule(5, 4, [{ field: "name", op: "contains_any", value: ["Trader Joe", "Whole Foods"] }], [cat(31)]),
    rule(6, 5, [{ field: "name", op: "one_of", value: ["Uber", "Lyft"] }], [cat(42)]),
    rule(7, 6, [{ field: "name", op: "contains_any", value: ["Netflix", "Spotify"] }], [cat(60)]),
    rule(8, 7, [{ field: "amount", op: "between", value: [-500, -100] }, { field: "name", op: "contains", value: "fee" }], [cat(14)], false),
  ];
}

export function fixtureRows(count = 3200): TxRow[] {
  const rand = mulberry32(42);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const day = (offset: number) => {
    const d = new Date(Date.UTC(2026, 10, 21));
    d.setUTCDate(d.getUTCDate() - offset);
    return d.toISOString().slice(0, 10);
  };
  const rows: TxRow[] = [];
  const base = (n: number, posted_on: string, account: number, amount: number, name: string, extra: Partial<TxRow> = {}): TxRow => ({
    id: ids.tx(n),
    account_id: ids.account(account),
    pending: false,
    posted_on,
    amount_cents: amount,
    name,
    renamed: false,
    merchant: name,
    raw_description: name.toUpperCase(),
    note: null,
    entity_id: accounts[account - 1].entity_id,
    category_id: null,
    category_source: "none",
    tax_line_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    hidden: false,
    recurring_id: null,
    source: "plaid",
    ...extra,
  });

  let n = 1;
  for (let i = 0; i < count; i++) {
    const posted = day(Math.floor((i / count) * 690));
    const roll = rand();
    if (roll < 0.035) {
      const dealPay = pick(["Wordwise", "Brightleaf", "Canvasly"]);
      rows.push(
        base(n++, posted, 3, 40000 + Math.floor(rand() * 260000), `${dealPay} payment`, {
          merchant: dealPay,
          category_id: ids.category(1),
          category_source: "manual",
          entity_id: UGC,
        }),
      );
      continue;
    }
    const [name, c, entity, lo, hi, account, ruleN] = pick(MERCHANTS);
    const amount = -(lo + Math.floor(rand() * (hi - lo + 1)));
    const row = base(n++, posted, account, amount, name, { entity_id: entity, pending: i < 6 });
    if (c && ruleN) {
      row.category_id = ids.category(c);
      row.category_source = "rule";
    } else if (c && rand() < 0.72) {
      row.category_id = ids.category(c);
      row.category_source = rand() < 0.6 ? "manual" : "import";
    }
    if (name === "Netflix") row.recurring_id = ids.recurring(2);
    if (name === "Spotify") row.recurring_id = ids.recurring(3);
    if (name === "Adobe Creative Cloud") row.recurring_id = ids.recurring(1);
    if (rand() < 0.012) row.hidden = true;
    if (rand() < 0.04) row.note = pick(["Reimbursable", "Shoot day", "Ask accountant", "Gift"]);
    rows.push(row);
  }

  // A few card payments, paired: money out of checking, money into the card.
  for (let k = 0; k < 6; k++) {
    const posted = day(10 + k * 30);
    const amount = 120000 + k * 17500;
    const out = base(n++, posted, 1, -amount, "Chase Card Payment", { is_transfer: true, category_source: "rule" });
    const into = base(n++, posted, 2, amount, "Payment Thank You", { is_transfer: true, category_source: "rule" });
    out.transfer_pair_id = into.id;
    into.transfer_pair_id = out.id;
    rows.push(out, into);
  }
  // One unpaired candidate pair, for the panel's "Pair with".
  rows.push(base(n++, day(3), 1, -50000, "Transfer to Business Checking"), base(n++, day(3), 3, 50000, "Transfer from Everyday Checking"));

  return rows.sort((a, b) => (a.posted_on === b.posted_on ? (a.id < b.id ? 1 : -1) : a.posted_on < b.posted_on ? 1 : -1));
}

export function fixtureLookups(): Lookups {
  return { accounts, entities, categories, taxLines, categoryTaxLines, recurring, deals };
}
