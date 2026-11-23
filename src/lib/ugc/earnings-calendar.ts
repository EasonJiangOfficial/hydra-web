/**
 * Earnings month calendar (ported from Ripple lib/finances/earnings-calendar.ts).
 *
 * Buckets per-video earning rows into the owner's local days. A day's $ is the
 * sum of its rows' `totalEarned`, plus each deal's `bonusDelta` (the per-deal
 * model's aggregate bonus above the row sums) on that deal's latest
 * contributing day. Days are "YYYY-MM-DD" in `zone` (default: this machine's
 * zone, as Ripple used server-local days).
 *
 * Ripple's "Money Lost" rate ladder is NOT ported: Hydra's missed money is
 * DESIGN.md section 8's rule (target shortfall x base pay, ledger.ts), passed
 * in as `missed`.
 */
import { NO_VIEW_READING } from "@/lib/ugc/format-views";
import { daysInMonth, dayKeyInZone, localZone } from "@/lib/ugc/days";

export { NO_VIEW_READING };

/** One per-video row (Ripple ReportEarningRow, dollars as plain numbers). */
export interface CalendarEarningRow {
  postedAt: string;
  campaignId: string | null;
  campaignName: string;
  description: string;
  totalViews: number;
  basePay: number;
  cpm: number;
  bonus: number;
  totalEarned: number;
  tier: string | null;
  excluded: boolean;
  isManualOverride?: boolean;
}

export interface CalendarCampaignLine {
  campaignId: string;
  campaignName: string;
  bonusDelta: number;
  /** Window-scoped deal total (already includes the bonus). */
  totalEarned: number;
}

/** Posts used for content metrics (views, post counts). */
export interface CalendarContentRow {
  postedAt: string;
  totalViews: number;
  campaignName: string;
  description: string;
  excluded?: boolean;
  campaignId?: string | null;
}

/** One day's missed money (ledger.ts). */
export interface DayMissed {
  /** Videos short of the day's summed targets. */
  missed: number;
  /** Missed money in dollars. */
  amount: number;
}

function toCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function safeAmount(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/**
 * A row whose dollars we cannot honestly show: no override, no views, $0.
 * Could be never-measured or a genuine zero; the dash is the safe direction.
 */
export function isRowEarningsUnknown(row: CalendarEarningRow): boolean {
  if (row.excluded) return false;
  if (row.isManualOverride) return false;
  if (safeAmount(row.totalEarned) > 0) return false;
  if (safeAmount(row.totalViews) > 0) return false;
  return true;
}

function latestRowDateByCampaign(rows: readonly CalendarEarningRow[]): Map<string, Date> {
  const latest = new Map<string, Date>();
  for (const row of rows) {
    if (row.excluded || !row.campaignId) continue;
    const at = new Date(row.postedAt);
    if (Number.isNaN(at.getTime())) continue;
    const current = latest.get(row.campaignId);
    if (!current || at.getTime() > current.getTime()) latest.set(row.campaignId, at);
  }
  return latest;
}

export interface EarningsCalendarDay {
  date: string;
  dayOfMonth: number;
  inMonth: boolean;
  isPad: boolean;
  isToday: boolean;
  videoCount: number;
  /** null = at least one video that day has no usable reading. */
  earnings: number | null;
  isPaid: boolean;
  /** Missed money that day, null when none. */
  lost: DayMissed | null;
}

export interface EarningsCalendarHighlights {
  bestDay: { date: string; earnings: number } | null;
  bestWeek: { start: string; end: string; earnings: number } | null;
}

export interface EarningsCalendarModel {
  month: string;
  days: EarningsCalendarDay[];
  sidebar: {
    /** null when the displayed month is not the current month, or views unknown. */
    viewsToday: number | null;
    postsToday: number | null;
    avgPerVideo: number | null;
    thisMonth: number | null;
  };
  byDeal: { id: string; name: string; earnings: number }[];
  highlights: EarningsCalendarHighlights;
}

export function buildEarningsCalendar(args: {
  rows: readonly CalendarEarningRow[];
  lines: readonly CalendarCampaignLine[];
  month: string;
  now?: Date;
  /** Owner's zone. Default: this machine's zone. */
  zone?: string;
  /** Canonical month total, when the caller has one. */
  thisMonth?: number;
  avgPerVideo?: number;
  /** All posts in scope. Money still uses `rows`. */
  contentRows?: readonly CalendarContentRow[];
  /** Missed money per day key. */
  missed?: ReadonlyMap<string, DayMissed> | null;
}): EarningsCalendarModel {
  const zone = args.zone ?? localZone();
  const dayOf = (at: Date) => dayKeyInZone(at, zone);
  const now = args.now ?? new Date();
  const todayKey = dayOf(now);
  const monthContainsToday = todayKey.slice(0, 7) === args.month;
  const pad = new Date(
    Date.UTC(Number(args.month.slice(0, 4)), Number(args.month.slice(5, 7)) - 1, 1),
  ).getUTCDay();

  const money = new Map<string, { amount: number; unknown: boolean }>();
  const videos = new Map<string, number>();
  const ensure = (key: string) => {
    if (!money.has(key)) money.set(key, { amount: 0, unknown: false });
    if (!videos.has(key)) videos.set(key, 0);
  };

  for (const row of args.rows) {
    const at = new Date(row.postedAt);
    if (Number.isNaN(at.getTime())) continue;
    const key = dayOf(at);
    if (key.slice(0, 7) !== args.month) continue;
    ensure(key);
    const cell = money.get(key)!;
    if (isRowEarningsUnknown(row)) {
      cell.unknown = true;
    } else if (!row.excluded) {
      cell.amount = toCents(cell.amount + safeAmount(row.totalEarned));
    }
  }

  const content = args.contentRows ?? args.rows;
  for (const row of content) {
    const at = new Date(row.postedAt);
    if (Number.isNaN(at.getTime())) continue;
    const key = dayOf(at);
    if (key.slice(0, 7) !== args.month) continue;
    ensure(key);
    videos.set(key, (videos.get(key) ?? 0) + 1);
  }

  const latestByCampaign = latestRowDateByCampaign(args.rows);
  for (const line of args.lines) {
    const delta = safeAmount(line.bonusDelta);
    if (delta <= 0) continue;
    const anchor = latestByCampaign.get(line.campaignId);
    if (!anchor) continue;
    const key = dayOf(anchor);
    if (key.slice(0, 7) !== args.month) continue;
    ensure(key);
    const cell = money.get(key)!;
    cell.amount = toCents(cell.amount + delta);
  }

  const days: EarningsCalendarDay[] = [];
  for (let i = 0; i < pad; i++) {
    days.push({
      date: "",
      dayOfMonth: 0,
      inMonth: false,
      isPad: true,
      isToday: false,
      videoCount: 0,
      earnings: null,
      isPaid: false,
      lost: null,
    });
  }
  for (let d = 1; d <= daysInMonth(args.month); d++) {
    const date = `${args.month}-${String(d).padStart(2, "0")}`;
    const cell = money.get(date);
    const earnings = !cell ? 0 : cell.unknown ? null : cell.amount;
    days.push({
      date,
      dayOfMonth: d,
      inMonth: true,
      isPad: false,
      isToday: date === todayKey,
      videoCount: videos.get(date) ?? 0,
      earnings,
      isPaid: earnings != null && earnings > 0,
      lost: args.missed?.get(date) ?? null,
    });
  }

  const inMonth = days.filter((d) => d.inMonth);

  let bestDay: EarningsCalendarHighlights["bestDay"] = null;
  for (const d of inMonth) {
    if (d.earnings == null || d.earnings <= 0) continue;
    if (!bestDay || d.earnings > bestDay.earnings) bestDay = { date: d.date, earnings: d.earnings };
  }

  let bestWeek: EarningsCalendarHighlights["bestWeek"] = null;
  for (let i = 0; i <= inMonth.length - 7; i++) {
    const window = inMonth.slice(i, i + 7);
    if (window.some((d) => d.earnings == null)) continue;
    const sum = toCents(window.reduce((s, d) => s + (d.earnings ?? 0), 0));
    if (sum <= 0) continue;
    if (!bestWeek || sum > bestWeek.earnings) {
      bestWeek = { start: window[0]!.date, end: window[6]!.date, earnings: sum };
    }
  }

  const todayRows = monthContainsToday
    ? content.filter((row) => {
        const at = new Date(row.postedAt);
        return !Number.isNaN(at.getTime()) && dayOf(at) === todayKey;
      })
    : [];
  const todayKnown = todayRows.filter((r) => safeAmount(r.totalViews) > 0);
  const viewsToday = !monthContainsToday
    ? null
    : todayRows.length === 0
      ? 0
      : todayKnown.length === 0
        ? null
        : todayKnown.reduce((s, r) => s + r.totalViews, 0);

  const thisMonth =
    typeof args.thisMonth === "number" && Number.isFinite(args.thisMonth)
      ? args.thisMonth
      : inMonth.some((d) => d.earnings == null)
        ? null
        : toCents(inMonth.reduce((s, d) => s + (d.earnings ?? 0), 0));

  const avgPerVideo =
    typeof args.avgPerVideo === "number" && Number.isFinite(args.avgPerVideo)
      ? args.avgPerVideo
      : null;

  const byDeal = args.lines
    .map((l) => ({ id: l.campaignId, name: l.campaignName, earnings: toCents(safeAmount(l.totalEarned)) }))
    .filter((d) => d.earnings > 0)
    .sort((a, b) => b.earnings - a.earnings);

  return {
    month: args.month,
    days,
    sidebar: {
      viewsToday,
      postsToday: monthContainsToday ? todayRows.length : null,
      avgPerVideo,
      thisMonth,
    },
    byDeal,
    highlights: { bestDay, bestWeek },
  };
}

export function formatDayMoney(amount: number | null): string {
  if (amount == null) return NO_VIEW_READING;
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/** "-$52" style: missed money always shows as a negative. */
export function formatMissedMoney(amount: number): string {
  return `-${formatDayMoney(amount)}`;
}
