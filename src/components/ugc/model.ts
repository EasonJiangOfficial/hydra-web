/**
 * The UGC Tracker model: raw rows in, money and views out. Pure and client-safe. All money comes from
 * the ledger (src/lib/ugc/ledger.ts); nothing here prices a video itself.
 */
import { formatMoney } from "@/components/kit/money";
import { addDays, dayKeyInZone, dayKeysBetween, monthDayKeys, zonedDayStart } from "@/lib/ugc/days";
import {
  countedByDay,
  dealEarnings,
  earnedByDay,
  missedMoney,
  postingCalendar,
  projectedMonthlyCents,
  summarizeDeal,
  targetOn,
  type DealEarnings,
  type DealRow,
  type DealSummary,
  type PostRow,
  type PostingCalendarDay,
  type VideoPay,
} from "@/lib/ugc/ledger";
import { formatCompactCount } from "@/lib/ugc/format-views";
import { matchDealOf, suggestPayoutMatches, type PayoutMatches } from "@/lib/ugc/payout-match";
import { needsMatching, type TwinReason } from "@/lib/ugc/match";
import { resolveViewAggregationMode } from "@/lib/ugc/pay-aggregate";
import type { DealDbRow, Platform } from "@/lib/ugc/schemas";
import type { PaymentRaw, PostRaw, UgcRaw } from "./types";

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** A stored deal with its bigint columns as numbers, in the shape the ledger reads. */
function toDealRow(d: DealDbRow): DealRow & DealDbRow {
  return {
    ...d,
    base_pay_cents: n(d.base_pay_cents),
    flat_rate_cents: n(d.flat_rate_cents),
    retainer_cents: n(d.retainer_cents),
  };
}

export interface DealView {
  deal: DealDbRow;
  row: DealRow & DealDbRow;
  summary: DealSummary;
  earnings: DealEarnings;
  /** Posts a creator could still have posted: elapsed target days x target, short. */
  missedCount: number;
  overrides: Map<string, number>;
  payments: PaymentRaw[];
  accounts: UgcRaw["accounts"];
  logoUrl: string | null;
}

export interface VideoView {
  key: string;
  dealId: string;
  brandName: string;
  postIds: string[];
  title: string;
  url: string;
  platform: Platform;
  handle: string | null;
  postedAt: string;
  day: string;
  views: number;
  hasReading: boolean;
  excluded: boolean;
  overridden: boolean;
  baseCents: number;
  cpmCents: number;
  bonusCents: number;
  payCents: number;
  /** The best post's recent readings, oldest first. */
  history: number[];
  lastCapturedDay: string | null;
  held: boolean;
  /** The reading held for review (a jump), which the owner can accept; null when none is held. */
  heldReading: { postId: string; views: number; capturedAt: string } | null;
  /**
   * Its platform posts, most views first. `paid` marks the posts whose views the ledger pays on: the max
   * one under "Highest platform", every one under "Combine platforms", none when the video is excluded.
   */
  posts: VideoPost[];
  /** The deal adds the platforms' views together ("Combine platforms"). */
  combined: boolean;
}

/** One platform post of a video. */
export interface VideoPost {
  id: string;
  platform: Platform;
  handle: string | null;
  url: string;
  title: string;
  postedAt: string;
  /** Payable views; null before the first reading. */
  views: number | null;
  paid: boolean;
}

/** A suggested twin for an unlinked post: a post alone, or a post of a linked video. */
export interface TwinView {
  post: VideoPost;
  /** Posts in the twin's video (1 when it is alone). */
  videoSize: number;
  reason: TwinReason;
  gapMs: number;
  /** Linking pays the video $0 (a post in it is excluded or priced $0): the matcher holds these back. */
  zeroes: boolean;
}

/** An unlinked post that looks like another platform's post of the same video. */
export interface NeedsMatchView {
  dealId: string;
  brandName: string;
  post: VideoPost;
  twins: TwinView[];
}

export interface Totals {
  earnedCents: number;
  paidCents: number;
  owedCents: number;
  missedCents: number;
  missedCount: number;
  projectedCents: number;
  videoCount: number;
  /** Earned, split the way the ledger splits it. */
  baseCents: number;
  cpmCents: number;
  bonusCents: number;
  adjustCents: number;
  flatCents: number;
  paymentCount: number;
}

export interface Model {
  zone: string;
  today: string;
  now: Date;
  deals: DealView[];
  videos: VideoView[];
  /** Unlinked posts with suggested twins (src/lib/ugc/match.ts needsMatching), newest first. */
  needsMatching: NeedsMatchView[];
  totals: Totals;
  /** The latest day any post got a reading. */
  lastReadingDay: string | null;
}

/** "tiktok.com/@name/video/123" for a post without a title. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function buildModel(raw: UgcRaw): Model {
  const now = new Date(raw.nowIso);
  const zone = raw.zone;
  const today = dayKeyInZone(now, zone);
  const viewById = new Map(raw.views.map((v) => [v.post_id, v]));
  const ledgerPosts: (PostRow & PostRaw)[] = raw.posts.map((p) => ({
    ...p,
    manual_override_cents: n(p.manual_override_cents),
    base_pay_cents_snap: n(p.base_pay_cents_snap),
    payable_views: n(viewById.get(p.id)?.payable_views),
  }));
  const postById = new Map(ledgerPosts.map((p) => [p.id, p]));
  const handleByAccount = new Map(raw.accounts.map((a) => [a.id, a.handle]));
  const snapsByPost = new Map<string, UgcRaw["snapshots"]>();
  for (const s of raw.snapshots) snapsByPost.set(s.post_id, [...(snapsByPost.get(s.post_id) ?? []), s]);

  const dealViews: DealView[] = [];
  const videos: VideoView[] = [];
  const needs: NeedsMatchView[] = [];
  for (const d of raw.deals) {
    const row = toDealRow(d);
    const earnings = dealEarnings(row, ledgerPosts, zone, today);
    const overrides = new Map(raw.dayTargets.filter((t) => t.deal_id === d.id).map((t) => [t.day, t.target]));
    const payments = raw.payments.filter((p) => p.deal_id === d.id);
    const paidCents = payments.reduce((s, p) => s + Number(p.amount_cents), 0);
    const missed = missedMoney({ deal: row, counted: countedByDay(earnings), overrides, today });
    dealViews.push({
      deal: d,
      row,
      summary: summarizeDeal({ deal: row, earnings, paidCents, overrides, today }),
      earnings,
      missedCount: missed.missed,
      overrides,
      payments,
      accounts: raw.accounts.filter((a) => a.deal_id === d.id),
      logoUrl: d.logo_path ? (raw.logos[d.logo_path] ?? null) : null,
    });
    for (const v of earnings.videos) videos.push(toVideoView(v, d.brand_name, resolveViewAggregationMode({ viewAggregationMode: row.view_aggregation_mode }) === "COMBINED", postById, handleByAccount, snapsByPost, viewById));
    const own = raw.posts.filter((p) => p.deal_id === d.id);
    const groupSize = new Map<string, number>();
    for (const p of own) if (p.video_group_id) groupSize.set(p.video_group_id, (groupSize.get(p.video_group_id) ?? 0) + 1);
    for (const m of needsMatching(own)) {
      needs.push({
        dealId: d.id,
        brandName: d.brand_name,
        post: postView(postById.get(m.postId)!, handleByAccount),
        twins: m.twins.map((t) => ({
          post: postView(postById.get(t.twinId)!, handleByAccount),
          videoSize: t.groupId ? (groupSize.get(t.groupId) ?? 1) : 1,
          reason: t.reason,
          gapMs: t.gapMs,
          zeroes: t.zeroes,
        })),
      });
    }
  }
  needs.sort((a, b) => Date.parse(b.post.postedAt) - Date.parse(a.post.postedAt));
  const rank = { active: 0, paused: 1, ended: 2 } as const;
  dealViews.sort((a, b) => rank[a.deal.status] - rank[b.deal.status] || a.deal.brand_name.localeCompare(b.deal.brand_name));
  videos.sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));

  const lastReadingDay = raw.views.reduce<string | null>(
    (best, v) => (v.last_captured_day && (!best || v.last_captured_day > best) ? v.last_captured_day : best),
    null,
  );
  return { zone, today, now, deals: dealViews, videos, needsMatching: needs, totals: totalsOf(dealViews, videos), lastReadingDay };
}

/** The five numbers and their parts over some deals and their videos. */
export function totalsOf(deals: readonly DealView[], videos: readonly VideoView[]): Totals {
  const sum = (f: (d: DealView) => number) => deals.reduce((s, d) => s + f(d), 0);
  const counted = videos.filter((v) => !v.excluded);
  const earnedCents = sum((d) => d.summary.earnedCents);
  const paidCents = sum((d) => d.summary.paidCents);
  return {
    earnedCents,
    paidCents,
    owedCents: earnedCents - paidCents,
    missedCents: sum((d) => d.summary.missedCents),
    missedCount: sum((d) => d.missedCount),
    projectedCents: sum((d) => d.summary.projectedCents),
    videoCount: counted.length,
    baseCents: counted.reduce((s, v) => s + v.baseCents, 0),
    cpmCents: counted.reduce((s, v) => s + v.cpmCents, 0),
    bonusCents: counted.reduce((s, v) => s + v.bonusCents, 0),
    adjustCents: sum((d) => d.earnings.bonusDeltaCents),
    flatCents: sum((d) => d.earnings.flatRateCents),
    paymentCount: sum((d) => d.payments.length),
  };
}

/** The totals for one deal, or for all of them. */
export function scopedTotals(model: Model, dealId: string | null): Totals {
  return dealId
    ? totalsOf(visibleDeals(model, dealId), model.videos.filter((v) => v.dealId === dealId))
    : model.totals;
}

/**
 * The five numbers over `[from, to]` (inclusive day keys, the page's period). Earned is what the ledger puts on
 * those days (video pay on its posting day, a per-deal adjustment on its day, a flat rate on the start day);
 * Paid is the deposits paid inside it; Missed counts its elapsed days. Owed is the balance at the period's end
 * (everything earned through `to` minus everything paid through `to`). Projected stays the next 30 days.
 */
export function periodTotals(model: Model, dealId: string | null, from: string, to: string): Totals & { paidToEndCents: number } {
  const deals = visibleDeals(model, dealId);
  const inside = (day: string | null) => day !== null && day >= from && day <= to;
  const counted = model.videos.filter((v) => (dealId === null || v.dealId === dealId) && !v.excluded && inside(v.day));
  let earnedCents = 0;
  let earnedToEnd = 0;
  let paidCents = 0;
  let paidToEnd = 0;
  let paymentCount = 0;
  let missedCents = 0;
  let missedCount = 0;
  let adjustCents = 0;
  let flatCents = 0;
  for (const d of deals) {
    for (const [day, cents] of earnedByDay(d.row, d.earnings)) {
      if (day <= to) earnedToEnd += cents;
      if (inside(day)) earnedCents += cents;
    }
    for (const p of d.payments) {
      if (p.paid_on > to) continue;
      paidToEnd += Number(p.amount_cents);
      if (p.paid_on >= from) {
        paidCents += Number(p.amount_cents);
        paymentCount++;
      }
    }
    const missed = missedMoney({
      deal: d.row,
      counted: countedByDay(d.earnings),
      overrides: d.overrides,
      today: model.today,
      range: { from, to },
    });
    missedCents += missed.cents;
    missedCount += missed.missed;
    if (inside(d.earnings.bonusDeltaDay)) adjustCents += d.earnings.bonusDeltaCents;
    if (inside(d.row.start_date)) flatCents += d.earnings.flatRateCents;
  }
  return {
    earnedCents,
    paidCents,
    owedCents: earnedToEnd - paidToEnd,
    missedCents,
    missedCount,
    projectedCents: deals.reduce((s, d) => s + d.summary.projectedCents, 0),
    videoCount: counted.length,
    baseCents: counted.reduce((s, v) => s + v.baseCents, 0),
    cpmCents: counted.reduce((s, v) => s + v.cpmCents, 0),
    bonusCents: counted.reduce((s, v) => s + v.bonusCents, 0),
    adjustCents,
    flatCents,
    paymentCount,
    paidToEndCents: paidToEnd,
  };
}

function toVideoView(
  v: VideoPay,
  brandName: string,
  combined: boolean,
  postById: Map<string, PostRow & PostRaw>,
  handleByAccount: Map<string, string>,
  snapsByPost: Map<string, UgcRaw["snapshots"]>,
  viewById: Map<string, UgcRaw["views"][number]>,
): VideoView {
  const members = v.postIds.map((id) => postById.get(id)!).filter(Boolean);
  // The ledger's best-row rule: most views, ties to the larger id.
  const best = members.reduce((a, b) => {
    const av = a.payable_views ?? 0;
    const bv = b.payable_views ?? 0;
    return bv > av || (bv === av && b.id > a.id) ? b : a;
  });
  const first = members.reduce((a, b) => (Date.parse(b.posted_at) < Date.parse(a.posted_at) ? b : a));
  const history = [...(snapsByPost.get(best.id) ?? [])]
    .sort((a, b) => a.captured_day.localeCompare(b.captured_day))
    .filter((s) => !s.held)
    .map((s) => Number(s.views));
  const view = viewById.get(best.id);
  const heldView = members.map((m) => viewById.get(m.id)).find((h) => h?.latest_held && h.last_captured_at && h.latest_views !== null);
  return {
    key: v.key,
    dealId: v.dealId,
    brandName,
    postIds: v.postIds,
    title: first.title?.trim() || displayUrl(first.url),
    url: first.url,
    platform: first.platform,
    handle: best.account_id ? (handleByAccount.get(best.account_id) ?? null) : null,
    postedAt: v.postedAt,
    day: v.day,
    views: v.views,
    hasReading: v.hasReading,
    excluded: v.excluded,
    overridden: v.overridden,
    baseCents: v.baseCents,
    cpmCents: v.cpmCents,
    bonusCents: v.bonusCents,
    payCents: v.payCents,
    history,
    lastCapturedDay: view?.last_captured_day ?? null,
    held: members.some((m) => viewById.get(m.id)?.latest_held),
    heldReading: heldView
      ? { postId: heldView.post_id, views: Number(heldView.latest_views), capturedAt: heldView.last_captured_at! }
      : null,
    combined,
    posts: members
      .map((m) => ({ ...postView(m, handleByAccount), paid: !v.excluded && (combined || m.id === best.id) }))
      .sort((a, b) => Number(b.paid) - Number(a.paid) || (b.views ?? -1) - (a.views ?? -1) || (a.id < b.id ? -1 : 1)),
  };
}

/** One post as a row; `paid` is set by its video (false: not part of a shown video). */
function postView(p: PostRow & PostRaw, handleByAccount: Map<string, string>): VideoPost {
  return {
    id: p.id,
    platform: p.platform,
    handle: p.account_id ? (handleByAccount.get(p.account_id) ?? null) : null,
    url: p.url,
    title: p.title?.trim() || displayUrl(p.url),
    postedAt: p.posted_at,
    views: p.payable_views ?? null,
    paid: false,
  };
}

// ─── Views of the model ──────────────────────────────────────────────────────

const MIN = 60_000;

/** "12 min apart", "3 h apart", "2 days apart". */
export function apart(ms: number): string {
  // Round first, then pick the unit, so 59.6 min reads "1 h", not "60 min".
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m} min apart`;
  const h = Math.round(ms / (60 * MIN));
  if (h < 24) return `${h} h apart`;
  const d = Math.round(ms / (24 * 60 * MIN));
  return `${d} ${d === 1 ? "day" : "days"} apart`;
}


/** An ended deal is "archived" on the page: it leaves the pickers, and the day cards after its end date. */
export const isArchived = (d: Pick<DealDbRow, "status">) => d.status === "ended";

/**
 * True when `day` is inside the deal's dates: on or after its start, and on or before its end when it has one.
 * An ended deal with no end date stopped on a day nobody stored, so it runs on no day.
 */
export function dealRunsOn(d: Pick<DealDbRow, "status" | "start_date" | "end_date">, day: string): boolean {
  if (day < d.start_date) return false;
  if (d.end_date) return day <= d.end_date;
  return d.status !== "ended";
}

export function visibleDeals(model: Model, dealId: string | null): DealView[] {
  return dealId ? model.deals.filter((d) => d.deal.id === dealId) : model.deals;
}

/** The posting calendar for a "YYYY-MM" month over the picked deals. */
export function calendarFor(model: Model, month: string, dealId: string | null): PostingCalendarDay[] {
  return postingCalendar({
    month,
    today: model.today,
    deals: visibleDeals(model, dealId).map((d) => ({ deal: d.row, earnings: d.earnings, overrides: d.overrides })),
  });
}

export interface CalendarSummary {
  hitDays: number;
  targetDays: number;
  streak: number;
}

/** "Hit target 16 of 21 days" and the streak ending today (or yesterday while today is still open). */
export function summarizeCalendar(days: readonly PostingCalendarDay[]): CalendarSummary {
  const elapsed = days.filter((d) => d.status !== "future" && d.status !== "none");
  const hitDays = elapsed.filter((d) => d.status === "hit").length;
  let streak = 0;
  for (let i = elapsed.length - 1; i >= 0; i--) {
    const d = elapsed[i];
    if (d.status === "hit") streak++;
    else if (d.isToday && streak === 0) continue;
    else break;
  }
  return { hitDays, targetDays: elapsed.length, streak };
}

export interface EarnedDay {
  day: string;
  cents: number;
  status: PostingCalendarDay["status"];
}

/** The posting calendar's days from `from` to `to` (inclusive), across months. */
export function calendarRange(model: Model, from: string, to: string, dealId: string | null): PostingCalendarDay[] {
  const cal: PostingCalendarDay[] = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = shiftMonth(m, 1)) {
    for (const c of calendarFor(model, m, dealId)) if (c.date >= from && c.date <= to) cal.push(c);
  }
  return cal;
}

/** Earned cents per day from `from` to `to` (inclusive), with each day's calendar status (bars: ink = hit, gray = under). */
export function earnedSeries(model: Model, from: string, to: string, dealId: string | null): EarnedDay[] {
  const cal = calendarRange(model, from, to, dealId);
  const total = new Map<string, number>();
  for (const d of visibleDeals(model, dealId)) {
    for (const [day, cents] of earnedByDay(d.row, d.earnings)) total.set(day, (total.get(day) ?? 0) + cents);
  }
  return cal.map((c) => ({ day: c.date, cents: total.get(c.date) ?? 0, status: c.status }));
}

export interface DayDeal {
  deal: DealView;
  /** The target that applies (override first); null = the deal has no target that day. */
  target: number | null;
  override: number | null;
  posted: number;
  earnedCents: number;
  missedCents: number;
  videos: VideoView[];
}

export interface DayDetail {
  day: string;
  future: boolean;
  deals: DayDeal[];
  posted: number;
  target: number;
  earnedCents: number;
  missedCents: number;
}

/** Everything the day panel shows for one "YYYY-MM-DD". */
export function dayDetail(model: Model, day: string): DayDetail {
  const rows: DayDeal[] = model.deals.map((d) => {
    const videos = model.videos.filter((v) => v.dealId === d.deal.id && v.day === day);
    const target = targetOn(d.row, day, d.overrides);
    const missed = missedMoney({
      deal: d.row,
      counted: countedByDay(d.earnings),
      overrides: d.overrides,
      today: model.today,
      range: { from: day, to: day },
    });
    return {
      deal: d,
      target,
      override: d.overrides.get(day) ?? null,
      posted: videos.filter((v) => !v.excluded).length,
      earnedCents: earnedByDay(d.row, d.earnings).get(day) ?? 0,
      missedCents: missed.cents,
      videos,
    };
  });
  // A deal shows on a day only between its start and end dates (owner, 2026-11-22), unless it has videos that
  // day: the calendar counts their money, so the day panel shows them too.
  const relevant = rows.filter((r) => r.videos.length > 0 || (r.target !== null && dealRunsOn(r.deal.deal, day)));
  return {
    day,
    future: day > model.today,
    deals: relevant,
    posted: relevant.reduce((s, r) => s + r.posted, 0),
    target: relevant.reduce((s, r) => s + (r.target ?? 0), 0),
    earnedCents: relevant.reduce((s, r) => s + r.earnedCents, 0),
    missedCents: relevant.reduce((s, r) => s + r.missedCents, 0),
  };
}

/** The first of the month `delta` months from "YYYY-MM". */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

/** Noon on `day` in the owner's zone, as an ISO instant (a new video's default posting time). */
export function noonOn(day: string, zone: string): string {
  return new Date(zonedDayStart(day, zone).getTime() + 12 * 3_600_000).toISOString();
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** "Nov 18" from a day key. */
export function shortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Wednesday, November 18" from a day key. */
export function longDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Weekday of the 1st (0 = Monday ... 6 = Sunday), for the calendar's leading blanks: weeks start Monday, as the Weekly period. */
export function firstWeekday(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
}

// ─── Pay summary and CSV ─────────────────────────────────────────────────────

const compact = (v: number) => formatCompactCount(v).replace(/\.0(?=[KMB]$)/, "");

/** One line for a deal row: "$25 base + bonus tiers", "$40 base + $2 per 1K views". */
export type PayTerms = Pick<
  DealDbRow,
  "base_pay_cents" | "cpm_rate" | "cpm_view_unit" | "cpm_tiers" | "view_bonuses" | "retainer_cents" | "flat_rate_cents"
>;

export function paySummary(d: PayTerms): string {
  const parts: string[] = [];
  const base = n(d.base_pay_cents);
  if (base) parts.push(`${formatMoney(base, { whole: base % 100 === 0 })} base`);
  const rate = n(d.cpm_rate);
  if (rate) {
    parts.push(`$${rate} per ${compact(d.cpm_view_unit)} views`);
  } else if ((d.cpm_tiers ?? []).length > 0) parts.push("CPM tiers");
  if ((d.view_bonuses ?? []).length > 0) parts.push(d.view_bonuses.length === 1 ? "1 bonus tier" : `${d.view_bonuses.length} bonus tiers`);
  if (n(d.retainer_cents)) parts.push(`${formatMoney(n(d.retainer_cents)!, { whole: true })} retainer`);
  if (n(d.flat_rate_cents)) parts.push(`${formatMoney(n(d.flat_rate_cents)!, { whole: true })} flat`);
  return parts.length > 0 ? parts.join(" + ") : "No pay set";
}

/** A CSV cell. Quotes when needed and defuses spreadsheet formulas (titles come from the web). */
export function csvCell(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

export function videosToCsv(rows: readonly VideoView[]): string {
  const head = ["Title", "Link", "Account", "Platform", "Deal", "Posted", "Views", "Base", "CPM", "Bonus", "Total", "Pay"];
  const lines = rows.map((v) =>
    [
      v.title,
      v.url,
      v.handle ? `@${v.handle}` : "",
      v.platform,
      v.brandName,
      v.day,
      v.hasReading ? v.views : "",
      dollars(v.baseCents),
      dollars(v.cpmCents),
      dollars(v.bonusCents),
      dollars(v.payCents),
      v.excluded ? "Excluded" : "Counted",
    ]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n");
}

/** The deal's projection for `perDay` posts a day (the calculator's what-if): perDay x base x 30. */
export function projectFor(row: DealRow, perDay: number): number {
  return projectedMonthlyCents({ ...row, status: "active", daily_target_posts: perDay });
}

export { addDays, dayKeysBetween, monthDayKeys };

/** Suggested payouts and learned-rule offers for the deals in scope (src/lib/ugc/payout-match.ts). */
export function payoutMatchesFor(model: Model, raw: UgcRaw, dealId: string | null = null): PayoutMatches {
  const deals = dealId ? model.deals.filter((d) => d.deal.id === dealId) : model.deals;
  return suggestPayoutMatches({
    today: model.today,
    deals: deals.map((d) => matchDealOf(d.row, d.earnings)),
    payments: raw.payments.map((p) => ({
      dealId: p.deal_id,
      transactionId: p.transaction_id,
      amountCents: Number(p.amount_cents),
      paidOn: p.paid_on,
      name: p.name,
    })),
    deposits: raw.deposits.map((d) => ({ id: d.id, name: d.name, amountCents: Number(d.amount_cents), postedOn: d.posted_on })),
    rules: raw.payoutRules.map((r) => ({
      dealId: r.deal_id,
      payerKey: r.payer_key,
      dayOfMonth: r.day_of_month,
      dayWindow: r.day_window,
      decision: r.decision,
    })),
    rejections: raw.payoutRejections.map((r) => ({ dealId: r.deal_id, transactionId: r.transaction_id })),
  });
}
