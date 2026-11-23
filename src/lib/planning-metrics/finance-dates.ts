import { addDays, daysUntil } from "@/lib/planning/dates";

/**
 * Read-only finance dates for the Planning calendar (DESIGN.md section 6, item 2): card due dates,
 * estimated tax dates and expected deal payouts. Pure: the page loads `FinanceFacts` once and the
 * calendar asks for any month. None of these can be dragged; they come from the money data.
 */

export type FinanceKind = "card" | "tax" | "payout";

export interface FinanceDate {
  /** Stable: kind, source and day. */
  readonly id: string;
  readonly date: string;
  readonly kind: FinanceKind;
  readonly label: string;
  /** Cents; null when not known. */
  readonly amountCents: number | null;
}

export interface CardFact {
  readonly id: string;
  /** "Chase Sapphire 4242" */
  readonly name: string;
  /** The next statement's due day, null when the feed has none. */
  readonly dueOn: string | null;
  readonly balanceCents: number | null;
}

export type PayCycle = "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "DAYS_OF_MONTH";

export interface DealFact {
  readonly id: string;
  readonly brand: string;
  readonly status: "active" | "paused" | "ended";
  readonly startDate: string;
  readonly endDate: string | null;
  readonly payCycle: PayCycle | null;
  readonly anchorDay: number | null;
  /** 0 Sunday to 6 Saturday. */
  readonly anchorWeekday: number | null;
  readonly anchorDays: readonly number[];
  /** Earned and not yet paid, cents. Shown on the next payout only. */
  readonly owedCents: number;
}

export interface FinanceFacts {
  readonly cards: readonly CardFact[];
  readonly deals: readonly DealFact[];
}

export const NO_FINANCE: FinanceFacts = { cards: [], deals: [] };

const weekday = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();
const lastDayOf = (date: string): number => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
const dayOfMonth = (date: string): number => Number(date.slice(8, 10));

/** A weekend due date moves to Monday (the IRS rule). Holidays are not applied. */
function nextBusinessDay(date: string): string {
  const w = weekday(date);
  return w === 6 ? addDays(date, 2) : w === 0 ? addDays(date, 1) : date;
}

/** Federal estimated payment dates that fall in [from, to]: Apr 15 (also the filing date), Jun 15, Sep 15, Jan 15. */
export function taxDates(from: string, to: string): FinanceDate[] {
  const out: FinanceDate[] = [];
  const first = Number(from.slice(0, 4)) - 1;
  const last = Number(to.slice(0, 4));
  for (let year = first; year <= last; year += 1) {
    const dues: [string, string][] = [
      [`${year}-04-15`, "Q1 estimated tax and tax return"],
      [`${year}-06-15`, "Q2 estimated tax"],
      [`${year}-09-15`, "Q3 estimated tax"],
      [`${year + 1}-01-15`, "Q4 estimated tax"],
    ];
    for (const [raw, label] of dues) {
      const date = nextBusinessDay(raw);
      if (date >= from && date <= to) out.push({ id: `tax:${raw}`, date, kind: "tax", label, amountCents: null });
    }
  }
  return out;
}

/** The days a deal pays on, inside [from, to] and inside the deal's own dates. */
export function payDays(deal: DealFact, from: string, to: string): string[] {
  if (!deal.payCycle) return [];
  const start = deal.startDate > from ? deal.startDate : from;
  const end = deal.endDate && deal.endDate < to ? deal.endDate : to;
  // A biweekly cycle counts from the first matching weekday on or after the deal's start.
  const wd = deal.anchorWeekday ?? weekday(deal.startDate);
  const anchor = addDays(deal.startDate, (wd - weekday(deal.startDate) + 7) % 7);
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const hit =
      deal.payCycle === "WEEKLY"
        ? deal.anchorWeekday !== null && weekday(d) === deal.anchorWeekday
        : deal.payCycle === "BIWEEKLY"
          ? weekday(d) === wd && daysUntil(d, anchor) % 14 === 0
          : deal.payCycle === "MONTHLY"
            ? deal.anchorDay !== null && dayOfMonth(d) === Math.min(deal.anchorDay, lastDayOf(d))
            : deal.anchorDays.some((n) => dayOfMonth(d) === Math.min(n, lastDayOf(d)));
    if (hit) days.push(d);
  }
  return days;
}

/** Everything the calendar shows as a finance date in [from, to], soonest first. `today` limits payouts to the future. */
export function financeDatesBetween(facts: FinanceFacts, from: string, to: string, today: string): FinanceDate[] {
  const out: FinanceDate[] = [];
  for (const card of facts.cards) {
    if (card.dueOn && card.dueOn >= from && card.dueOn <= to) {
      out.push({ id: `card:${card.id}:${card.dueOn}`, date: card.dueOn, kind: "card", label: `${card.name} due`, amountCents: card.balanceCents });
    }
  }
  out.push(...taxDates(from, to));
  for (const deal of facts.deals) {
    if (deal.status !== "active") continue;
    const days = payDays(deal, from > today ? from : today, to);
    // The owed amount belongs to the next payout, wherever the month starts.
    const next = payDays(deal, today, addDays(today, 62))[0];
    for (const date of days) {
      out.push({
        id: `payout:${deal.id}:${date}`,
        date,
        kind: "payout",
        label: `${deal.brand} payout`,
        amountCents: date === next && deal.owedCents > 0 ? deal.owedCents : null,
      });
    }
  }
  return out.sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1));
}
