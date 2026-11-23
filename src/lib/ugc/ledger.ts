/**
 * UGC ledger: what each deal earned, was paid, is owed, missed and projects.
 * Pure (no database). queries.ts loads rows and calls these. DESIGN.md section 8.
 *
 *   - Pay per video (default) = calcPay: base (if views reach the minimum) +
 *     CPM + the highest bonus tier THAT video passes. A COMBINED cpm_tier_mode
 *     prices the CPM lane once on the deal's summed views and splits it back
 *     over the videos by views (as Ripple's video-earnings does). The deal setting
 *     `per_deal_model` switches to Ripple's computeAggregatePay (one bonus on
 *     the deal's summed views).
 *   - Rates come from each post's snapshot (copied from the deal at insert by a
 *     database trigger), so later rate edits never reprice old videos.
 *   - Posts sharing a `video_group_id` are ONE video, paid once.
 *   - Excluded video: pays $0, does not count toward the posting target.
 *   - Missed money (new) = for each elapsed deal day,
 *     max(0, target - counted videos that day) x base pay. A day target
 *     override of 0 is a day off. Paused spans (deals.paused_spans, kept by a
 *     database trigger) have no target; days before a pause keep theirs.
 *   - Projection = active deals: target per day x base pay x the days of
 *     [today, today + 29] inside [start_date, end_date].
 *   - Owed = earned - matched deposits.
 *
 * All money out of here is integer cents. Days are owner-zone "YYYY-MM-DD".
 */
import Decimal from "decimal.js";
import { calcPay } from "@/lib/ugc/campaign-earnings";
import {
  computeAggregatePay,
  cpmPayForRate,
  groupPayViews,
  resolveRowRate,
  resolveViewAggregationMode,
  type AggregateVideoInput,
  type FallbackRate,
  type RateSnapshotRow,
  type ResolvedRate,
} from "@/lib/ugc/pay-aggregate";
import {
  computeCombinedCpmPay,
  distributeCombinedCpm,
  isCombinedTierMode,
  sanitizeCpmTiers,
  type CpmTier,
} from "@/lib/ugc/pay-cpm";
import { centsToDollars, toCents } from "@/lib/ugc/money";
import { MONTH_PROJECTION_DAYS, postsPerDay } from "@/lib/ugc/projection";
import { dayKeyInZone, dayKeysBetween, addDays, monthDayKeys } from "@/lib/ugc/days";

export type DealStatus = "active" | "paused" | "ended";

/** A pause: no target from `from` to `to` (both included); `to` null = still paused. */
export interface PausedSpan {
  from: string;
  to: string | null;
}

/** A view bonus tier as stored (jsonb): a flat bonus in cents at a views threshold. */
export interface BonusTierCents {
  views: number;
  bonusCents: number;
}

/** The pay columns of `public.deals`. */
export interface DealPayTerms {
  base_pay_cents: number | null;
  base_min_views: number;
  view_bonuses: BonusTierCents[];
  view_bonus_mode: string;
  cpm_rate: number | string | null;
  cpm_view_unit: number;
  cpm_cap_views: number | null;
  cpm_min_views: number | null;
  cpm_tiers: CpmTier[];
  cpm_mode: string;
  cpm_tier_mode: string;
}

/** The `public.deals` columns the ledger reads. */
export interface DealRow extends DealPayTerms {
  id: string;
  brand_name: string;
  status: DealStatus;
  start_date: string;
  end_date: string | null;
  per_deal_model: boolean;
  view_aggregation_mode: string;
  daily_target_posts: number;
  flat_rate_cents: number | null;
  /** Written by the deals_track_pause trigger. Absent on old rows = no pause history. */
  paused_spans?: PausedSpan[] | null;
}

/** A `public.posts` row joined with its payable views (`ugc_post_views`). */
export interface PostRow {
  id: string;
  deal_id: string;
  posted_at: string;
  video_group_id: string | null;
  exclude_from_pay: boolean;
  manual_override_cents: number | null;
  base_pay_cents_snap: number | null;
  base_min_views_snap: number | null;
  view_bonuses_snap: BonusTierCents[] | null;
  view_bonus_mode_snap: string | null;
  cpm_rate_snap: number | string | null;
  cpm_view_unit_snap: number | null;
  cpm_cap_views_snap: number | null;
  cpm_min_views_snap: number | null;
  cpm_tiers_snap: CpmTier[] | null;
  cpm_mode_snap: string | null;
  cpm_tier_mode_snap: string | null;
  /** Latest trusted reading inside the freeze window; null = no reading yet. */
  payable_views: number | null;
}

const num = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v);

const bonusesToDollars = (tiers: BonusTierCents[]) =>
  tiers.map((t) => ({ views: t.views, bonus: centsToDollars(t.bonusCents) }));

/** The deal's current rate, used for a post without a snapshot (a Ripple import). */
export function dealFallbackRate(deal: DealPayTerms): FallbackRate {
  return {
    paymentPerVideo: centsToDollars(deal.base_pay_cents ?? 0),
    basePayMinViews: deal.base_min_views,
    viewBonuses: bonusesToDollars(deal.view_bonuses ?? []),
    viewBonusMode: deal.view_bonus_mode,
    cpmRatePerUnit: num(deal.cpm_rate),
    cpmViewUnit: deal.cpm_view_unit,
    cpmCapViews: deal.cpm_cap_views,
    cpmTiers: sanitizeCpmTiers(deal.cpm_tiers),
    cpmMode: deal.cpm_mode,
    cpmMinViews: deal.cpm_min_views,
    tierEvaluationMode: deal.cpm_tier_mode,
  };
}

/** A post's snapshot columns in the shape Ripple's resolveRowRate reads. */
export function postRateSnapshot(post: PostRow): RateSnapshotRow {
  const pay = post.base_pay_cents_snap;
  const rate = num(post.cpm_rate_snap);
  return {
    paymentPerVideoSnapshot: pay === null ? null : new Decimal(pay).div(100),
    basePayMinViewsSnapshot: post.base_min_views_snap ?? 0,
    viewBonusesSnapshot: post.view_bonuses_snap === null ? null : bonusesToDollars(post.view_bonuses_snap),
    viewBonusModeSnapshot: post.view_bonus_mode_snap ?? "REPLACE",
    cpmRateSnapshot: rate === null ? null : new Decimal(rate),
    cpmViewUnitSnapshot: post.cpm_view_unit_snap ?? 1000,
    cpmCapViewsSnapshot: post.cpm_cap_views_snap,
    cpmTiersSnapshot: post.cpm_tiers_snap,
    cpmModeSnapshot: post.cpm_mode_snap ?? "ADD",
    cpmMinViewsSnapshot: post.cpm_min_views_snap,
    tierEvaluationModeSnapshot: post.cpm_tier_mode_snap ?? "PER_VIDEO",
  };
}

/** One video: a post, or every post sharing its `video_group_id` in the deal. */
export interface VideoPay {
  key: string;
  dealId: string;
  postIds: string[];
  /** Earliest member's posting time; the video counts on this day. */
  postedAt: string;
  day: string;
  /** Payable views (best account under HIGHEST, the sum under COMBINED). */
  views: number;
  /** False when no member has a reading yet. */
  hasReading: boolean;
  excluded: boolean;
  overridden: boolean;
  baseCents: number;
  cpmCents: number;
  bonusCents: number;
  /** What this video earns. Equals base + cpm + bonus. 0 when excluded. */
  payCents: number;
}

export interface DealEarnings {
  dealId: string;
  videos: VideoPay[];
  /** Per-deal model only: the aggregate total above the video rows (any sign). */
  bonusDeltaCents: number;
  /** Day the delta lands on: the latest counted video's day. */
  bonusDeltaDay: string | null;
  /** One-time flat rate, earned on the start day once that day has come. */
  flatRateCents: number;
  /** Everything above: video pay + delta + flat rate. */
  earnedCents: number;
}

interface Group {
  key: string;
  rows: PostRow[];
}

function groupVideos(posts: readonly PostRow[]): Group[] {
  const map = new Map<string, PostRow[]>();
  for (const p of posts) {
    const key = p.video_group_id ? `g:${p.video_group_id}` : `p:${p.id}`;
    const list = map.get(key) ?? [];
    list.push(p);
    map.set(key, list);
  }
  return [...map.entries()].map(([key, rows]) => ({ key, rows }));
}

/** Ripple's best-row rule: most views, ties to the larger id (deterministic). */
function bestRow(rows: readonly PostRow[]): PostRow {
  return rows.reduce((a, b) => {
    const av = a.payable_views ?? 0;
    const bv = b.payable_views ?? 0;
    return bv > av || (bv === av && b.id > a.id) ? b : a;
  });
}

function basePayFor(rate: ResolvedRate, views: number): number {
  return rate.basePayMinViews > 0 && views < rate.basePayMinViews ? 0 : rate.paymentPerVideo;
}

/** Earnings of one deal from its posts. `today` gates the flat rate. */
export function dealEarnings(
  deal: DealRow,
  posts: readonly PostRow[],
  zone: string,
  today: string,
): DealEarnings {
  const fallback = dealFallbackRate(deal);
  const mode = resolveViewAggregationMode({ viewAggregationMode: deal.view_aggregation_mode });
  const videos: VideoPay[] = [];
  const aggInputs: AggregateVideoInput[] = [];
  let latest: { at: number; day: string } | null = null;
  // Per-video model under a COMBINED tier mode: the videos whose CPM is repriced below.
  const cpmPool: { video: VideoPay; rate: ResolvedRate; baseBonusCents: number }[] = [];
  let vote: { at: number; key: string; rate: ResolvedRate } | null = null;

  for (const { key, rows } of groupVideos(posts.filter((p) => p.deal_id === deal.id))) {
    const best = bestRow(rows);
    const memberViews = rows.map((r) => r.payable_views ?? 0);
    const views = groupPayViews(memberViews, mode);
    const first = rows.reduce((a, b) => (Date.parse(b.posted_at) < Date.parse(a.posted_at) ? b : a));
    const day = dayKeyInZone(new Date(first.posted_at), zone);
    const excluded = rows.some((r) => r.exclude_from_pay);
    const overrideRow = rows.find((r) => r.manual_override_cents !== null);
    const overrideCents = overrideRow?.manual_override_cents ?? null;
    const rate = resolveRowRate(postRateSnapshot(best), fallback);

    let baseCents = 0;
    let cpmCents = 0;
    let bonusCents = 0;
    let baseBonusCents = 0;
    if (!excluded && overrideCents !== null) {
      baseCents = overrideCents; // an override IS the video's pay; it rides the base line
    } else if (!excluded && !deal.per_deal_model) {
      const res = calcPay(
        memberViews,
        rate.paymentPerVideo,
        rate.viewBonuses,
        rate.viewBonusMode === "ADD" ? "ADD" : "REPLACE",
        rate.basePayMinViews,
        {
          cpmRate: rate.cpmRatePerUnit,
          cpmViewUnit: rate.cpmViewUnit,
          cpmCapViews: rate.cpmCapViews,
          cpmTiers: rate.cpmTiers,
          cpmMode: rate.cpmMode,
          cpmMinViews: rate.cpmMinViews,
        },
        { viewAggregationMode: mode },
      );
      const payCents = toCents(res.pay);
      baseBonusCents = toCents(res.lanes.baseBonus);
      const cpmWins = rate.cpmMode === "REPLACE" && res.lanes.cpm > res.lanes.baseBonus;
      if (!cpmWins) {
        baseCents = toCents(basePayFor(rate, views));
        bonusCents = toCents(res.lanes.baseBonus) - baseCents;
      }
      cpmCents = payCents - baseCents - bonusCents;
    } else if (!excluded) {
      // Per-deal model rows carry base + per-video CPM; the aggregate bonus
      // (and any composition difference) lands as the deal's delta below.
      baseCents = toCents(basePayFor(rate, views));
      cpmCents = toCents(cpmPayForRate(views, rate));
    }

    if (deal.per_deal_model) {
      aggInputs.push({
        bestViews: views,
        rate,
        override: overrideCents === null ? null : new Decimal(overrideCents).div(100),
        excluded,
        postedAt: new Date(best.posted_at),
        dealKey: best.id,
      });
    }
    if (!excluded) {
      const at = Date.parse(best.posted_at);
      if (!latest || at > latest.at) latest = { at, day };
      // Ripple's latest-deal vote: the newest counted video's rate picks the tier mode.
      if (!vote || at > vote.at || (at === vote.at && best.id > vote.key)) vote = { at, key: best.id, rate };
    }

    const video: VideoPay = {
      key,
      dealId: deal.id,
      postIds: rows.map((r) => r.id),
      postedAt: first.posted_at,
      day,
      views,
      hasReading: rows.some((r) => r.payable_views !== null),
      excluded,
      overridden: overrideCents !== null,
      baseCents,
      cpmCents,
      bonusCents,
      payCents: baseCents + cpmCents + bonusCents,
    };
    videos.push(video);
    const hasCpm = (rate.cpmRatePerUnit ?? 0) > 0 || rate.cpmTiers.length > 0;
    if (!deal.per_deal_model && !excluded && overrideCents === null && hasCpm) {
      cpmPool.push({ video, rate, baseBonusCents });
    }
  }

  if (!deal.per_deal_model && vote && isCombinedTierMode(vote.rate.tierEvaluationMode)) {
    repriceCombinedCpm(cpmPool, vote.rate, vote.rate.tierEvaluationMode);
  }

  const videoPayCents = videos.reduce((s, v) => s + v.payCents, 0);
  const bonusDeltaCents = deal.per_deal_model
    ? toCents(computeAggregatePay(aggInputs).totalPay) - videoPayCents
    : 0;
  const flatRateCents = deal.flat_rate_cents && deal.start_date <= today ? deal.flat_rate_cents : 0;
  return {
    dealId: deal.id,
    videos,
    bonusDeltaCents,
    bonusDeltaDay: latest?.day ?? null,
    flatRateCents,
    earnedCents: videoPayCents + bonusDeltaCents + flatRateCents,
  };
}

/**
 * Per-video model, COMBINED tier mode: the CPM lane is priced ONCE on the summed
 * views of the videos that carry CPM (latest video's schedule), then split back
 * over them by views to the exact cent. Base and bonus stay per video; under
 * cpm_mode REPLACE each video keeps the better of its base+bonus and its share.
 */
function repriceCombinedCpm(
  pool: readonly { video: VideoPay; rate: ResolvedRate; baseBonusCents: number }[],
  schedule: ResolvedRate,
  mode: "COMBINED_BRACKETED" | "COMBINED_FLAT",
): void {
  const total = computeCombinedCpmPay(
    pool.reduce((s, p) => s + p.video.views, 0),
    {
      ratePerUnit: schedule.cpmRatePerUnit,
      viewUnit: schedule.cpmViewUnit,
      capViews: schedule.cpmCapViews,
      tiers: schedule.cpmTiers,
      minViews: schedule.cpmMinViews ?? null,
    },
    mode,
  );
  const shares = distributeCombinedCpm(
    pool.map((p) => p.video.views),
    total,
  );
  pool.forEach(({ video, rate, baseBonusCents }, i) => {
    const share = toCents(shares[i]);
    const base = toCents(basePayFor(rate, video.views));
    if (rate.cpmMode === "REPLACE" && share > baseBonusCents) {
      video.baseCents = 0;
      video.bonusCents = 0;
      video.cpmCents = share;
    } else {
      video.baseCents = base;
      video.bonusCents = baseBonusCents - base;
      video.cpmCents = rate.cpmMode === "REPLACE" ? 0 : share;
    }
    video.payCents = video.baseCents + video.bonusCents + video.cpmCents;
  });
}

/** Earned cents per day: video pay on its day, the delta on its day, the flat rate on the start day. */
export function earnedByDay(deal: DealRow, earnings: DealEarnings): Map<string, number> {
  const out = new Map<string, number>();
  const add = (day: string | null, cents: number) => {
    if (!day || cents === 0) return;
    out.set(day, (out.get(day) ?? 0) + cents);
  };
  for (const v of earnings.videos) add(v.day, v.payCents);
  add(earnings.bonusDeltaDay, earnings.bonusDeltaCents);
  add(deal.start_date, earnings.flatRateCents);
  return out;
}

/** Counted (non-excluded) videos per day. */
export function countedByDay(earnings: DealEarnings): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of earnings.videos) if (!v.excluded) out.set(v.day, (out.get(v.day) ?? 0) + 1);
  return out;
}

const spansOf = (deal: DealRow): PausedSpan[] => (Array.isArray(deal.paused_spans) ? deal.paused_spans : []);

/**
 * Last day the deal's target applies, or null when it accrues no target at all:
 * an ended deal without an end date, or a paused deal with no recorded pause
 * (a Ripple import: the day it paused is unknown).
 */
function targetWindowEnd(deal: DealRow): string | null | "open" {
  if (deal.status === "paused" && !spansOf(deal).some((s) => s.to === null)) return null;
  if (deal.end_date) return deal.end_date;
  return deal.status === "ended" ? null : "open";
}

/** True when `day` falls inside one of the deal's pauses. */
export function isPausedOn(deal: DealRow, day: string): boolean {
  return spansOf(deal).some((s) => s.from <= day && (s.to === null || day <= s.to));
}

/**
 * The pauses after a status change on `today` (the deals_track_pause trigger, in
 * TypeScript for the in-memory fixture). Pausing opens a span from today;
 * leaving a pause closes it on yesterday (a same-day pause leaves nothing).
 */
export function nextPausedSpans(
  spans: readonly PausedSpan[] | null | undefined,
  from: DealStatus,
  to: DealStatus,
  today: string,
): PausedSpan[] {
  const list = [...(spans ?? [])];
  if (to === "paused" && from !== "paused") return [...list, { from: today, to: null }];
  if (from === "paused" && to !== "paused") {
    const yesterday = addDays(today, -1);
    return list.flatMap((s) => (s.to !== null ? [s] : s.from > yesterday ? [] : [{ from: s.from, to: yesterday }]));
  }
  return list;
}

/** The deal's target on `day` (override first), or null when the deal has no target that day. */
export function targetOn(
  deal: DealRow,
  day: string,
  overrides: ReadonlyMap<string, number> | undefined,
): number | null {
  const end = targetWindowEnd(deal);
  if (end === null || day < deal.start_date || (end !== "open" && day > end)) return null;
  if (isPausedOn(deal, day)) return null;
  return overrides?.get(day) ?? deal.daily_target_posts;
}

export interface DayMissedCents {
  missed: number;
  cents: number;
}

/**
 * Missed money for one deal over its ELAPSED days (start → yesterday, inside
 * `range` when given): max(0, target - counted) x base pay per day.
 * Today is not elapsed: it can still be saved.
 */
export function missedMoney(args: {
  deal: DealRow;
  counted: ReadonlyMap<string, number>;
  overrides?: ReadonlyMap<string, number>;
  today: string;
  range?: { from: string; to: string };
}): { cents: number; missed: number; byDay: Map<string, DayMissedCents> } {
  const { deal } = args;
  const byDay = new Map<string, DayMissedCents>();
  const base = deal.base_pay_cents ?? 0;
  const end = targetWindowEnd(deal);
  if (end === null) return { cents: 0, missed: 0, byDay };
  let from = deal.start_date;
  let to = addDays(args.today, -1);
  if (end !== "open" && end < to) to = end;
  if (args.range) {
    if (args.range.from > from) from = args.range.from;
    if (args.range.to < to) to = args.range.to;
  }
  let cents = 0;
  let missed = 0;
  for (const day of dayKeysBetween(from, to)) {
    const target = targetOn(deal, day, args.overrides) ?? 0;
    const short = Math.max(0, target - (args.counted.get(day) ?? 0));
    if (short === 0) continue;
    byDay.set(day, { missed: short, cents: short * base });
    missed += short;
    cents += short * base;
  }
  return { cents, missed, byDay };
}

/**
 * A deal's 30-day projection: target per day x base pay x the days of
 * [today, today + 29] that fall inside [start_date, end_date]. Active deals only.
 * Without `today` (the calculator's what-if) it is a flat 30 days.
 */
export function projectedMonthlyCents(deal: DealRow, today?: string): number {
  if (deal.status !== "active") return 0;
  return postsPerDay(deal.daily_target_posts) * projectionDays(deal, today) * (deal.base_pay_cents ?? 0);
}

/** The deal's days inside [today, today + 29] (30 without `today`). */
export function projectionDays(deal: Pick<DealRow, "start_date" | "end_date">, today?: string): number {
  if (today === undefined) return MONTH_PROJECTION_DAYS;
  const from = deal.start_date > today ? deal.start_date : today;
  const last = addDays(today, MONTH_PROJECTION_DAYS - 1);
  const to = deal.end_date && deal.end_date < last ? deal.end_date : last;
  return from > to ? 0 : dayKeysBetween(from, to).length;
}

/** Owed = earned - matched deposits. Negative means paid ahead. */
export function owedCents(earned: number, paid: number): number {
  return earned - paid;
}

export interface DealSummary {
  dealId: string;
  earnedCents: number;
  paidCents: number;
  owedCents: number;
  missedCents: number;
  projectedCents: number;
  videoCount: number;
}

export function summarizeDeal(args: {
  deal: DealRow;
  earnings: DealEarnings;
  paidCents: number;
  overrides?: ReadonlyMap<string, number>;
  today: string;
}): DealSummary {
  const missed = missedMoney({
    deal: args.deal,
    counted: countedByDay(args.earnings),
    overrides: args.overrides,
    today: args.today,
  });
  return {
    dealId: args.deal.id,
    earnedCents: args.earnings.earnedCents,
    paidCents: args.paidCents,
    owedCents: owedCents(args.earnings.earnedCents, args.paidCents),
    missedCents: missed.cents,
    projectedCents: projectedMonthlyCents(args.deal, args.today),
    videoCount: args.earnings.videos.filter((v) => !v.excluded).length,
  };
}

/** Calendar day state: filled ink = target hit, gray = under, outlined = zero (DESIGN.md section 7). */
export type DayStatus = "hit" | "under" | "zero" | "none" | "future";

export interface CalendarDealCell {
  dealId: string;
  brandName: string;
  posted: number;
  target: number;
  earnedCents: number;
  missedCents: number;
}

export interface PostingCalendarDay {
  date: string;
  isToday: boolean;
  posted: number;
  target: number;
  earnedCents: number;
  missedCents: number;
  status: DayStatus;
  deals: CalendarDealCell[];
}

/** One month of the posting calendar across deals. */
export function postingCalendar(args: {
  month: string;
  today: string;
  deals: readonly { deal: DealRow; earnings: DealEarnings; overrides?: ReadonlyMap<string, number> }[];
}): PostingCalendarDay[] {
  const keys = monthDayKeys(args.month);
  const range = { from: keys[0]!, to: keys[keys.length - 1]! };
  const perDeal = args.deals.map(({ deal, earnings, overrides }) => {
    const counted = countedByDay(earnings);
    return {
      deal,
      overrides,
      counted,
      earned: earnedByDay(deal, earnings),
      missed: missedMoney({ deal, counted, overrides, today: args.today, range }).byDay,
    };
  });
  return keys.map((date) => {
    const deals: CalendarDealCell[] = [];
    for (const d of perDeal) {
      const target = targetOn(d.deal, date, d.overrides) ?? 0;
      const posted = d.counted.get(date) ?? 0;
      const earnedCents = d.earned.get(date) ?? 0;
      const missedCents = d.missed.get(date)?.cents ?? 0;
      if (target === 0 && posted === 0 && earnedCents === 0) continue;
      deals.push({ dealId: d.deal.id, brandName: d.deal.brand_name, posted, target, earnedCents, missedCents });
    }
    const posted = deals.reduce((s, c) => s + c.posted, 0);
    const target = deals.reduce((s, c) => s + c.target, 0);
    const status: DayStatus =
      date > args.today
        ? "future"
        : target === 0 && posted === 0
          ? "none"
          : posted === 0
            ? "zero"
            : posted >= target
              ? "hit"
              : "under";
    return {
      date,
      isToday: date === args.today,
      posted,
      target,
      earnedCents: deals.reduce((s, c) => s + c.earnedCents, 0),
      missedCents: deals.reduce((s, c) => s + c.missedCents, 0),
      status,
      deals,
    };
  });
}
