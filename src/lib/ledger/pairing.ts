import { daysUntil } from "@/lib/planning/dates";

/**
 * Transfer and card-payment pairing between the owner's own accounts. Pure.
 * A pair is one outflow and one inflow of the same amount on two different accounts, posted within
 * `windowDays` of each other. A card payment is the same shape (checking out, card in).
 * Pending rows, rows already paired and rows the owner edited by hand are left alone.
 * Each row pairs at most once; an outflow takes the closest-dated match (ties: the earlier row, then the lower id).
 */

export interface PairCandidate {
  id: string;
  account_id: string;
  amount_cents: number;
  posted_on: string;
  pending: boolean;
  transfer_pair_id: string | null;
  category_source: "rule" | "manual" | "import" | "none";
}

export const DEFAULT_PAIR_WINDOW_DAYS = 5;

const byDayThenId = (x: PairCandidate, y: PairCandidate) =>
  x.posted_on.localeCompare(y.posted_on) || x.id.localeCompare(y.id);

export function findTransferPairs(
  rows: readonly PairCandidate[],
  windowDays = DEFAULT_PAIR_WINDOW_DAYS,
): { a: string; b: string }[] {
  const open = rows.filter((r) => !r.pending && !r.transfer_pair_id && r.category_source !== "manual" && r.amount_cents !== 0);
  const inflows = open.filter((r) => r.amount_cents > 0).sort(byDayThenId);
  const used = new Set<string>();
  const pairs: { a: string; b: string }[] = [];

  for (const out of open.filter((r) => r.amount_cents < 0).sort(byDayThenId)) {
    let best: PairCandidate | null = null;
    let bestGap = Infinity;
    for (const into of inflows) {
      if (used.has(into.id) || into.account_id === out.account_id || into.amount_cents !== -out.amount_cents) continue;
      const gap = Math.abs(daysUntil(into.posted_on, out.posted_on));
      if (gap <= windowDays && gap < bestGap) {
        best = into;
        bestGap = gap;
      }
    }
    if (best) {
      used.add(best.id);
      pairs.push({ a: out.id, b: best.id });
    }
  }
  return pairs;
}

/** A pairing candidate plus what decides whether a pair is clear. */
export interface AutoPairRow extends PairCandidate {
  /** The account's kind; null when the account is unknown. */
  account_kind: "cash" | "card" | "loan" | "asset" | null;
  /** The row's category kind; null with no category. */
  category_kind: "income" | "expense" | "transfer" | null;
  /** A deal payment points at this row: it is UGC income, never a transfer. */
  deal_matched: boolean;
  /** The bank's text: a card or loan credit must read like a payment to pair by itself. */
  name?: string | null;
  raw_description?: string | null;
}

/** "PAYMENT - THANK YOU", "AUTOPAY PYMT", "ONLINE PMT": what a card or loan credit says when it is a payment. */
// ponytail: a word list; a merchant refund worded like a payment would still pair. Plaid's category when stored.
const PAYMENT_WORDS = /\b(payment|pymt|pmt|autopay|thank you)\b/i;
const reads = (r: AutoPairRow) => PAYMENT_WORDS.test(`${r.name ?? ""} ${r.raw_description ?? ""}`);
const isCash = (r: AutoPairRow) => r.account_kind === "cash" || r.account_kind === "asset";
const isDebt = (r: AutoPairRow) => r.account_kind === "card" || r.account_kind === "loan";

/** Rows pairing may look at: posted, unpaired, not set by hand, not a deal payment, not income or expense. */
function openRows(rows: readonly AutoPairRow[]) {
  return rows.filter(
    (r) =>
      !r.pending &&
      !r.transfer_pair_id &&
      r.category_source !== "manual" &&
      r.amount_cents !== 0 &&
      r.account_kind !== null &&
      !r.deal_matched &&
      r.category_kind !== "income" &&
      r.category_kind !== "expense",
  );
}

/** Each outflow with its one inflow (same amount, other account, within the window) when both sides have exactly one. */
function uniqueMatches(
  outs: readonly AutoPairRow[],
  ins: readonly AutoPairRow[],
  windowDays: number,
  skip: (a: string, b: string) => boolean = () => false,
) {
  const fits = (out: AutoPairRow, into: AutoPairRow) =>
    into.account_id !== out.account_id &&
    into.amount_cents === -out.amount_cents &&
    Math.abs(daysUntil(into.posted_on, out.posted_on)) <= windowDays &&
    !skip(out.id, into.id);
  const pairs: { a: string; b: string }[] = [];
  for (const out of outs) {
    const into = ins.filter((i) => fits(out, i));
    if (into.length !== 1 || outs.filter((o) => fits(o, into[0]!)).length !== 1) continue;
    pairs.push({ a: out.id, b: into[0]!.id });
  }
  return pairs;
}

/**
 * The pairs automatic pairing takes (sync pages, import, the daily sweep, the agent). Pure.
 * Only a card or loan payment: money leaves a cash or asset account and lands on a card or loan
 * account as a credit that reads like a payment (or a rule marked as a transfer), same amount, within
 * `windowDays`, one candidate on each side. Money between two cash accounts is never paired here: it
 * may be a payout and a bill of the same amount, so it waits as a suggestion (findTransferSuggestions).
 */
export function findClearPairs(rows: readonly AutoPairRow[], windowDays = DEFAULT_PAIR_WINDOW_DAYS): { a: string; b: string }[] {
  const open = openRows(rows);
  const outs = open.filter((r) => r.amount_cents < 0 && isCash(r));
  const ins = open.filter((r) => r.amount_cents > 0 && isDebt(r) && (r.category_kind === "transfer" || reads(r)));
  return uniqueMatches(outs, ins, windowDays);
}

/** The key of a pair the owner said is not a transfer, either way round. */
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Possible transfers between two cash or asset accounts, for the Needs review queue. Pure. Same
 * checks as findClearPairs, one candidate on each side, minus the pairs in `rejected` (pairKey).
 * Both rows keep counting as income and spending until the owner marks the pair.
 */
export function findTransferSuggestions(
  rows: readonly AutoPairRow[],
  rejected: ReadonlySet<string> = new Set(),
  windowDays = DEFAULT_PAIR_WINDOW_DAYS,
): { a: string; b: string }[] {
  const open = openRows(rows).filter(isCash);
  return uniqueMatches(
    open.filter((r) => r.amount_cents < 0),
    open.filter((r) => r.amount_cents > 0),
    windowDays,
    (a, b) => rejected.has(pairKey(a, b)),
  );
}
