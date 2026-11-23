/**
 * Payout matching: which open bank deposit pays which deal. Pure (no database, client-safe).
 *
 * Brand payouts land as PayPal transfers, wires, real-time transfers, ACH and Zelle, never with the
 * brand's name, so the name alone cannot match them. Instead:
 *   - Cycles. A deal's pay days (finance-dates payDays) cut its earned-by-day into cycles; a cycle
 *     holds the work before its pay day and closes ON that day. Matched deposits pay the oldest
 *     cycles first, so each closed cycle has what is still owed on it. No pay cycle: everything
 *     earned through today is one cycle that closes today.
 *   - Amount. A deposit fits when it is within TOLERANCE of one open cycle, or of a run of open
 *     cycles from the oldest (a brand paying a backlog), and it landed on or after the last of
 *     those cycles closed.
 *   - Payer history. Deposits confirmed for a deal teach its payer (payerKey of the bank name):
 *     the same payer again raises the score; a payer only ever confirmed for another deal lowers it.
 *   - Learned rules. After two confirmations from one payer, a rule is offered ("PayPal transfers
 *     around the 1st are Wordwise"). An accepted rule suggests a deposit from that payer near that
 *     day while the deal owes something, even when the amount does not fit; it never beats another
 *     deal's amount fit. A payer confirmed for two deals (a shared channel: PayPal, Zelle) gets no
 *     rule, and an old rule for it stops applying. A declined rule is not offered again.
 *   - A payout within tolerance closes the cycles it pays (the gap is a fee), so a fee never
 *     stays open to pull in small unrelated deposits.
 *   - "Not this" removes that deposit from that deal for good.
 * Each deposit is suggested for one deal, and one cycle takes one deposit (best scores first).
 * Money is integer cents; days are owner-zone "YYYY-MM-DD".
 */
import { payDays, type PayCycle } from "@/lib/planning-metrics/finance-dates";
import { addDays, daysUntil } from "@/lib/planning/dates";
import { earnedByDay, type DealEarnings, type DealRow } from "@/lib/ugc/ledger";
import type { DealDbRow } from "@/lib/ugc/schemas";

/** A fit: within 5% of the owed amount, and never tighter than $2 (fees, rounding). */
export const TOLERANCE_RATE = 0.05;
export const TOLERANCE_MIN_CENTS = 200;
/** How many open cycles one deposit may pay at most. */
const MAX_CYCLES = 6;
/** Confirmations from one payer before a rule is offered. */
export const RULE_AFTER = 2;
/** A rule names a day when the payer's deposits land within this many days of it. */
const RULE_SPREAD = 4;
export const RULE_WINDOW = 3;

export interface MatchDeal {
  id: string;
  brandName: string;
  startDate: string;
  endDate: string | null;
  status: "active" | "paused" | "ended";
  payCycle: PayCycle | null;
  anchorDay: number | null;
  anchorWeekday: number | null;
  anchorDays: readonly number[];
  /** ledger earnedByDay. */
  earnedByDay: ReadonlyMap<string, number>;
  /** ledger earnedCents (any cents not on a day are put on the start day). */
  earnedCents: number;
}

/** A deal and its ledger earnings in the shape the matcher reads. */
export function matchDealOf(row: DealRow & DealDbRow, earnings: DealEarnings): MatchDeal {
  return {
    id: row.id,
    brandName: row.brand_name,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    payCycle: (row.pay_cycle as PayCycle | null) ?? null,
    anchorDay: row.pay_cycle_anchor_day ?? null,
    anchorWeekday: row.pay_cycle_anchor_weekday ?? null,
    anchorDays: row.pay_cycle_anchor_days ?? [],
    earnedByDay: earnedByDay(row, earnings),
    earnedCents: earnings.earnedCents,
  };
}

export interface MatchPayment {
  dealId: string;
  transactionId: string;
  amountCents: number;
  paidOn: string;
  name: string | null;
}

export interface MatchDeposit {
  id: string;
  name: string;
  amountCents: number;
  postedOn: string;
}

export interface MatchRule {
  dealId: string;
  payerKey: string;
  dayOfMonth: number | null;
  dayWindow: number;
  decision: "accepted" | "declined";
}

export interface MatchRejection {
  dealId: string;
  transactionId: string;
}

export interface Cycle {
  /** First work day in the cycle. */
  from: string;
  /** The pay day: the cycle closes on it. Today for a deal with no pay cycle. */
  closesOn: string;
  /** A deposit that pays this cycle lands on or after this day: the close, or the start without a pay cycle. */
  payableFrom: string;
  earnedCents: number;
  /** Earned minus the deposits allocated to it (oldest first). */
  owedCents: number;
}

export interface PayoutSuggestion {
  transactionId: string;
  dealId: string;
  brandName: string;
  depositName: string;
  amountCents: number;
  postedOn: string;
  /** What the deposit was compared with: the owed sum of the cycles it pays; null for a rule-only match. */
  owedCents: number | null;
  cycles: Pick<Cycle, "from" | "closesOn" | "owedCents">[];
  score: number;
  /** Short lines for the hover. */
  reasons: string[];
}

export interface RuleOffer {
  dealId: string;
  brandName: string;
  payerKey: string;
  /** "Paypal Transfer" */
  payerLabel: string;
  dayOfMonth: number | null;
  confirmations: number;
  /** "Paypal Transfer around the 1st is Wordwise" */
  text: string;
}

export interface PayoutMatchInput {
  today: string;
  deals: readonly MatchDeal[];
  payments: readonly MatchPayment[];
  deposits: readonly MatchDeposit[];
  rules: readonly MatchRule[];
  rejections: readonly MatchRejection[];
}

export interface PayoutMatches {
  suggestions: PayoutSuggestion[];
  ruleOffers: RuleOffer[];
}

const NOISE = new Set(["from", "to", "recd", "rcvd", "ref", "id", "ach", "ppd", "ccd", "web", "co", "inc", "llc", "ltd", "the", "for", "via", "credit", "dep", "deposit"]);

/** A payer's bank name without the noise: "PAYPAL TRANSFER 1001" -> "paypal transfer". Same payer, same key. */
export function payerKey(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !NOISE.has(w));
  return words.slice(0, 3).join(" ");
}

export const title = (key: string) => key.replace(/\b[a-z]/g, (c) => c.toUpperCase());

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** Days from `date` to the nearest `dayOfMonth` (this, last or next month; clamped to short months). Feb 27 is 2 days from Mar 1. */
function dayGap(date: string, dayOfMonth: number): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  let best = Infinity;
  for (const k of [-1, 0, 1]) {
    const yy = y + Math.floor((m - 1 + k) / 12);
    const mm = ((m - 1 + k + 12) % 12) + 1;
    const d = Math.min(dayOfMonth, lastDayOf(yy, mm));
    const at = `${yy}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    best = Math.min(best, Math.abs(daysUntil(date, at)));
  }
  return best;
}

/** The pay cycle the deal can use: none when its anchor is missing (a WEEKLY deal with no weekday has no pay days). */
function usableCycle(deal: MatchDeal): PayCycle | null {
  const c = deal.payCycle;
  if (c === "WEEKLY" && deal.anchorWeekday === null) return null;
  if (c === "MONTHLY" && deal.anchorDay === null) return null;
  if (c === "DAYS_OF_MONTH" && deal.anchorDays.length === 0) return null;
  return c;
}

export function tolerance(owedCents: number): number {
  return Math.max(TOLERANCE_MIN_CENTS, Math.round(Math.abs(owedCents) * TOLERANCE_RATE));
}

/**
 * The deal's closed cycles through today with what is still owed on each. Given the matched deposits,
 * each pays the cycles it fits; a bare total (or a deposit that fits nothing) pays the oldest first.
 */
export function owedCycles(
  deal: MatchDeal,
  paid: number | readonly Pick<MatchPayment, "amountCents" | "paidOn">[],
  today: string,
): Cycle[] {
  deal = { ...deal, payCycle: usableCycle(deal) };
  const byDay = new Map(deal.earnedByDay);
  const onDays = [...byDay.values()].reduce((s, c) => s + c, 0);
  if (deal.earnedCents !== onDays) byDay.set(deal.startDate, (byDay.get(deal.startDate) ?? 0) + deal.earnedCents - onDays);

  const closes = deal.payCycle
    ? payDays(
        {
          id: deal.id,
          brand: deal.brandName,
          status: deal.status,
          startDate: deal.startDate,
          // Work stops at the end date; its payout comes on the next pay day after it.
          endDate: deal.endDate ? addDays(deal.endDate, 62) : null,
          payCycle: deal.payCycle,
          anchorDay: deal.anchorDay,
          anchorWeekday: deal.anchorWeekday,
          anchorDays: deal.anchorDays,
          owedCents: 0,
        },
        addDays(deal.startDate, 1),
        today,
      )
    : [today];

  const cycles: Cycle[] = [];
  let from = deal.startDate;
  for (const closesOn of closes) {
    let earned = 0;
    for (const [day, cents] of byDay) if (day >= from && (day < closesOn || (!deal.payCycle && day <= closesOn))) earned += cents;
    cycles.push({ from, closesOn, payableFrom: deal.payCycle ? closesOn : deal.startDate, earnedCents: earned, owedCents: earned });
    from = closesOn;
    if (deal.endDate && from > deal.endDate) break;
  }
  const out = cycles.filter((c) => c.earnedCents > 0);
  const fifo = (cents: number) => {
    let left = cents;
    for (const c of out) {
      const take = Math.min(Math.max(c.owedCents, 0), left);
      c.owedCents -= take;
      left -= take;
    }
  };
  if (typeof paid === "number") {
    fifo(paid);
    return out;
  }
  // Each deposit pays the cycles it fits (as a suggestion would have matched it); else the oldest first.
  for (const p of [...paid].sort((a, b) => a.paidOn.localeCompare(b.paidOn))) {
    const fit = bestFit(out, p.amountCents, p.paidOn);
    if (!fit) {
      fifo(p.amountCents);
      continue;
    }
    // A fit closes its cycles: a short payout is a fee, not money still owed. Any extra pays the oldest.
    for (const i of fit.idx) out[i]!.owedCents = 0;
    if (p.amountCents > fit.owed) fifo(p.amountCents - fit.owed);
  }
  return out;
}

/** The open cycle, or run of open cycles from the oldest, whose owed sum is nearest `amount` within tolerance. */
function bestFit(cycles: readonly Cycle[], amount: number, on: string): { idx: number[]; owed: number } | null {
  const open = cycles.map((c, i) => ({ c, i })).filter(({ c }) => c.owedCents > 0);
  const tries: number[][] = open.map(({ i }) => [i]);
  for (let n = 2; n <= Math.min(MAX_CYCLES, open.length); n++) tries.push(open.slice(0, n).map(({ i }) => i));
  let fit: { idx: number[]; owed: number } | null = null;
  for (const idx of tries) {
    if (on < cycles[idx[idx.length - 1]!]!.payableFrom) continue;
    const owed = idx.reduce((s, i) => s + cycles[i]!.owedCents, 0);
    const gap = Math.abs(amount - owed);
    if (gap > tolerance(owed)) continue;
    if (!fit || gap < Math.abs(amount - fit.owed)) fit = { idx, owed };
  }
  return fit;
}

interface Candidate extends PayoutSuggestion {
  /** Indexes into the deal's open cycles. */
  cycleIdx: number[];
}

/** Suggested matches (best first) and rule offers. */
export function suggestPayoutMatches(input: PayoutMatchInput): PayoutMatches {
  const { today } = input;
  const deals = input.deals.map((d) => ({ ...d, payCycle: usableCycle(d) }));
  const rejected = new Set(input.rejections.map((r) => `${r.dealId}:${r.transactionId}`));
  const matchedTx = new Set(input.payments.map((p) => p.transactionId));

  // Payer history: payerKey -> deal -> confirmations.
  const history = new Map<string, Map<string, MatchPayment[]>>();
  for (const p of input.payments) {
    if (!p.name) continue;
    const key = payerKey(p.name);
    if (!key) continue;
    const byDeal = history.get(key) ?? new Map<string, MatchPayment[]>();
    byDeal.set(p.dealId, [...(byDeal.get(p.dealId) ?? []), p]);
    history.set(key, byDeal);
  }
  const open = new Map<string, Cycle[]>();
  for (const deal of deals) {
    const paid = input.payments.filter((p) => p.dealId === deal.id);
    open.set(deal.id, owedCycles(deal, paid, today).filter((c) => c.owedCents > 0));
  }

  const candidates: Candidate[] = [];
  for (const dep of input.deposits) {
    if (dep.amountCents <= 0 || matchedTx.has(dep.id) || dep.postedOn > today) continue;
    const key = payerKey(dep.name);
    for (const deal of deals) {
      if (rejected.has(`${deal.id}:${dep.id}`) || dep.postedOn < deal.startDate) continue;
      const cycles = open.get(deal.id) ?? [];
      const reasons: string[] = [];
      let score = 0;
      // Amount: one cycle, or a run of cycles from the oldest open one.
      const fit = bestFit(cycles, dep.amountCents, dep.postedOn);
      if (fit) {
        const gap = Math.abs(dep.amountCents - fit.owed);
        score += 60 - Math.round((gap / tolerance(fit.owed)) * 20);
        const waited = daysUntil(dep.postedOn, cycles[fit.idx[fit.idx.length - 1]!]!.payableFrom);
        if (deal.payCycle && waited > 45) score -= 10;
        reasons.push(
          !deal.payCycle
            ? `Owed ${money(fit.owed)} in all`
            : fit.idx.length === 1
            ? `Owed ${money(fit.owed)} for the cycle that closed ${shortDay(cycles[fit.idx[0]!]!.closesOn)}`
            : `Owed ${money(fit.owed)} for ${fit.idx.length} cycles through ${shortDay(cycles[fit.idx[fit.idx.length - 1]!]!.closesOn)}`,
        );
      }

      // Learned rule: only while the payer is this deal's alone, and (without a fit) only while the deal owes something.
      const rule = input.rules.find((r) => r.dealId === deal.id && r.payerKey === key && r.decision === "accepted");
      const ruleHit =
        !!rule &&
        !sharedPayer(history, key) &&
        (rule.dayOfMonth === null || dayGap(dep.postedOn, rule.dayOfMonth) <= rule.dayWindow) &&
        (!!fit || cycles.some((c) => c.payableFrom <= dep.postedOn));
      if (ruleHit) {
        score += fit ? 30 : 50;
        reasons.push(ruleText(title(key), rule.dayOfMonth, deal.brandName));
      }
      if (!fit && !ruleHit) continue;

      // Payer history.
      const seen = key ? history.get(key) : undefined;
      const mine = seen?.get(deal.id)?.length ?? 0;
      if (mine > 0) {
        score += 25;
        reasons.push(`${title(key)} paid ${deal.brandName} ${mine} ${mine === 1 ? "time" : "times"} before`);
      } else if (seen && seen.size > 0) {
        score -= 15;
      }

      candidates.push({
        transactionId: dep.id,
        dealId: deal.id,
        brandName: deal.brandName,
        depositName: dep.name,
        amountCents: dep.amountCents,
        postedOn: dep.postedOn,
        owedCents: fit ? fit.owed : null,
        cycles: fit ? fit.idx.map((i) => pickCycle(cycles[i]!)) : [],
        score,
        reasons,
        cycleIdx: fit ? fit.idx : [],
      });
    }
  }

  // Amount fits first (a rule alone never beats another deal's fit), then best score; each deposit once, each cycle once.
  const fits = (c: Candidate) => (c.owedCents === null ? 0 : 1);
  candidates.sort((a, b) => fits(b) - fits(a) || b.score - a.score || b.postedOn.localeCompare(a.postedOn) || a.transactionId.localeCompare(b.transactionId));
  const usedTx = new Set<string>();
  const usedCycle = new Set<string>();
  const suggestions: PayoutSuggestion[] = [];
  for (const c of candidates) {
    if (usedTx.has(c.transactionId)) continue;
    if (c.cycleIdx.some((i) => usedCycle.has(`${c.dealId}:${i}`))) continue;
    usedTx.add(c.transactionId);
    for (const i of c.cycleIdx) usedCycle.add(`${c.dealId}:${i}`);
    const s: PayoutSuggestion & { cycleIdx?: number[] } = { ...c };
    delete s.cycleIdx;
    suggestions.push(s);
  }

  return { suggestions, ruleOffers: ruleOffers(input, history) };
}

function ruleOffers(input: PayoutMatchInput, history: Map<string, Map<string, MatchPayment[]>>): RuleOffer[] {
  const decided = new Set(input.rules.map((r) => `${r.dealId}:${r.payerKey}`));
  const brand = new Map(input.deals.map((d) => [d.id, d.brandName]));
  const out: RuleOffer[] = [];
  for (const [key, byDeal] of history) {
    for (const [dealId, paid] of byDeal) {
      if (paid.length < RULE_AFTER || byDeal.size > 1 || decided.has(`${dealId}:${key}`) || !brand.has(dealId)) continue;
      // The day that sits nearest all of them (around the month end); none when they spread out.
      let best: { day: number; spread: number } | null = null;
      for (let d = 1; d <= 31; d++) {
        const spread = Math.max(...paid.map((p) => dayGap(p.paidOn, d)));
        if (!best || spread < best.spread) best = { day: d, spread };
      }
      const dayOfMonth = best && best.spread <= RULE_SPREAD ? best.day : null;
      const label = title(key);
      out.push({
        dealId,
        brandName: brand.get(dealId)!,
        payerKey: key,
        payerLabel: label,
        dayOfMonth,
        confirmations: paid.length,
        text: ruleText(label, dayOfMonth, brand.get(dealId)!),
      });
    }
  }
  return out.sort((a, b) => b.confirmations - a.confirmations || a.text.localeCompare(b.text));
}

/** A payer confirmed for more than one deal (PayPal, Zelle): its name says nothing about the deal. */
const sharedPayer = (history: Map<string, Map<string, MatchPayment[]>>, key: string) => (history.get(key)?.size ?? 0) > 1;

export function ruleText(label: string, dayOfMonth: number | null, brand: string): string {
  return dayOfMonth === null ? `${label} is ${brand}` : `${label} around the ${ordinal(dayOfMonth)} is ${brand}`;
}

const pickCycle = (c: Cycle) => ({ from: c.from, closesOn: c.closesOn, owedCents: c.owedCents });
const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
