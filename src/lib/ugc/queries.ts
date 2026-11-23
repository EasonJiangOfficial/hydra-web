import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";
import { createServerClient } from "@/lib/supabase/server";
import {
  dealEarnings,
  earnedByDay,
  postingCalendar,
  summarizeDeal,
  type DealEarnings,
  type DealRow,
  type DealSummary,
  type PostRow,
  type PostingCalendarDay,
} from "@/lib/ugc/ledger";
import { dayKeySchema, monthKeySchema, type DealDbRow, type Platform } from "@/lib/ugc/schemas";
import { dayKeyInZone, dayKeysBetween } from "@/lib/ugc/days";
import { ugcDealsOnly } from "@/lib/ugc/personal";
import { matchDealOf, suggestPayoutMatches, type PayoutMatches } from "@/lib/ugc/payout-match";
import { isViewsFrozen } from "@/lib/ugc/view-freeze";
import { readTemplates, type TemplateDbRow } from "@/lib/ugc/templates";
import { zoneOf, type Db } from "@/lib/ugc/writes";

/**
 * UGC reads for pages and the Hydra Agent. Each runs as the signed-in owner
 * (RLS: anyone else reads nothing), loads the UGC rows and computes money in
 * ledger.ts. `now` is injectable. A database error throws an Error.
 * ponytail: every read loads all UGC rows (one creator: thousands of posts);
 * add date filters when a load gets slow.
 */

const PAGE = 1000;

async function selectAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: PostgrestError | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`UGC read failed: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

export interface AccountRow {
  id: string;
  deal_id: string;
  platform: Platform;
  handle: string;
}

interface PostLedgerRow extends Omit<PostRow, "payable_views"> {
  url: string;
  platform: Platform;
  title: string | null;
}

interface PostViewRow {
  post_id: string;
  payable_views: number | null;
  latest_views: number | null;
  last_captured_at: string | null;
  last_captured_day: string | null;
  latest_held: boolean;
}

const POST_LEDGER_COLUMNS =
  "id, deal_id, url, platform, title, posted_at, video_group_id, exclude_from_pay, manual_override_cents, " +
  "base_pay_cents_snap, base_min_views_snap, view_bonuses_snap, view_bonus_mode_snap, cpm_rate_snap, " +
  "cpm_view_unit_snap, cpm_cap_views_snap, cpm_min_views_snap, cpm_tiers_snap, cpm_mode_snap, cpm_tier_mode_snap";

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** A stored deal with its bigint columns as numbers. */
function toDealRow(d: DealDbRow): DealRow & DealDbRow {
  return {
    ...d,
    base_pay_cents: n(d.base_pay_cents),
    flat_rate_cents: n(d.flat_rate_cents),
    retainer_cents: n(d.retainer_cents),
  };
}

interface Ledger {
  zone: string;
  today: string;
  now: Date;
  deals: (DealRow & DealDbRow)[];
  posts: (PostLedgerRow & { payable_views: number | null })[];
  views: Map<string, PostViewRow>;
  accounts: AccountRow[];
  paidByDeal: Map<string, number>;
  overridesByDeal: Map<string, Map<string, number>>;
  earnings: Map<string, DealEarnings>;
}

async function loadLedger(db: Db, now: Date): Promise<Ledger> {
  const [zone, storedDeals, allPosts, views, allPayments, allTargets, allAccounts] = await Promise.all([
    zoneOf(db),
    // The Personal Brand deal is not UGC work (0140): none of its rows count here.
    selectAll<DealDbRow>((a, b) => db.from("deals").select("*").order("id").range(a, b)),
    selectAll<PostLedgerRow>((a, b) => db.from("posts").select(POST_LEDGER_COLUMNS).order("id").range(a, b)),
    selectAll<PostViewRow>((a, b) =>
      db
        .from("ugc_post_views")
        .select("post_id, payable_views, latest_views, last_captured_at, last_captured_day, latest_held")
        .order("post_id")
        .range(a, b),
    ),
    selectAll<{ deal_id: string; amount_cents: number }>((a, b) =>
      db.from("deal_payments").select("deal_id, amount_cents").order("id").range(a, b),
    ),
    selectAll<{ deal_id: string; day: string; target: number }>((a, b) =>
      db.from("day_targets").select("deal_id, day, target").order("deal_id").order("day").range(a, b),
    ),
    selectAll<AccountRow>((a, b) =>
      db.from("deal_accounts").select("id, deal_id, platform, handle").order("id").range(a, b),
    ),
  ]);
  const { deals, has } = ugcDealsOnly(storedDeals);
  const posts = allPosts.filter(has);
  const payments = allPayments.filter(has);
  const targets = allTargets.filter(has);
  const accounts = allAccounts.filter(has);
  const today = dayKeyInZone(now, zone);
  const viewMap = new Map(views.map((v) => [v.post_id, v]));
  const ledgerPosts = posts.map((p) => ({
    ...p,
    manual_override_cents: n(p.manual_override_cents),
    base_pay_cents_snap: n(p.base_pay_cents_snap),
    payable_views: n(viewMap.get(p.id)?.payable_views),
  }));
  const paidByDeal = new Map<string, number>();
  for (const p of payments) paidByDeal.set(p.deal_id, (paidByDeal.get(p.deal_id) ?? 0) + Number(p.amount_cents));
  const overridesByDeal = new Map<string, Map<string, number>>();
  for (const t of targets) {
    const m = overridesByDeal.get(t.deal_id) ?? new Map<string, number>();
    m.set(t.day, t.target);
    overridesByDeal.set(t.deal_id, m);
  }
  const dealRows = deals.map(toDealRow);
  const earnings = new Map(dealRows.map((d) => [d.id, dealEarnings(d, ledgerPosts, zone, today)]));
  return {
    zone,
    today,
    now,
    deals: dealRows,
    posts: ledgerPosts,
    views: viewMap,
    accounts,
    paidByDeal,
    overridesByDeal,
    earnings,
  };
}

async function ledger(now?: Date): Promise<Ledger> {
  // Read the clock only after cookies() (inside createServerClient): under Cache Components
  // a `new Date()` before any request API fails the /ugc prerender and the build.
  const db = await createServerClient();
  return loadLedger(db, now ?? new Date());
}

export interface DealListItem extends DealSummary {
  deal: DealDbRow;
  accounts: AccountRow[];
}

export interface DealList {
  zone: string;
  today: string;
  deals: DealListItem[];
  totals: Omit<DealSummary, "dealId">;
}

/** Every deal with earned, paid, owed, missed and projected (cents), plus totals. Active deals first. */
export async function listDeals(opts: { now?: Date } = {}): Promise<DealList> {
  const l = await ledger(opts.now);
  const rank = { active: 0, paused: 1, ended: 2 } as const;
  const deals = l.deals
    .map((deal) => ({
      ...summarizeDeal({
        deal,
        earnings: l.earnings.get(deal.id)!,
        paidCents: l.paidByDeal.get(deal.id) ?? 0,
        overrides: l.overridesByDeal.get(deal.id),
        today: l.today,
      }),
      deal,
      accounts: l.accounts.filter((a) => a.deal_id === deal.id),
    }))
    .sort((a, b) => rank[a.deal.status] - rank[b.deal.status] || a.deal.brand_name.localeCompare(b.deal.brand_name));
  const sum = (k: keyof Omit<DealSummary, "dealId">) => deals.reduce((s, d) => s + d[k], 0);
  return {
    zone: l.zone,
    today: l.today,
    deals,
    totals: {
      earnedCents: sum("earnedCents"),
      paidCents: sum("paidCents"),
      owedCents: sum("owedCents"),
      missedCents: sum("missedCents"),
      projectedCents: sum("projectedCents"),
      videoCount: sum("videoCount"),
    },
  };
}

/** The "already created" deals the owner can add (brand, logo, pay structure). Archived hidden by default. */
export async function listDealTemplates(opts: { includeArchived?: boolean } = {}): Promise<TemplateDbRow[]> {
  return readTemplates(await createServerClient(), opts);
}

/** The posting calendar for one month ("YYYY-MM"): per day posted of target, earned, missed, per deal. */
export async function postingCalendarMonth(input: {
  month: string;
  now?: Date;
}): Promise<{ month: string; zone: string; today: string; days: PostingCalendarDay[] }> {
  const month = monthKeySchema.parse(input.month);
  const l = await ledger(input.now);
  const days = postingCalendar({
    month,
    today: l.today,
    deals: l.deals.map((deal) => ({
      deal,
      earnings: l.earnings.get(deal.id)!,
      overrides: l.overridesByDeal.get(deal.id),
    })),
  });
  return { month, zone: l.zone, today: l.today, days };
}

const rangeSchema = z
  .object({ from: dayKeySchema, to: dayKeySchema })
  .refine((r) => r.from <= r.to && dayKeysBetween(r.from, r.to).length <= 1000, "Use a range of 1 to 1000 days");

/** Earned cents per owner-zone day from `from` to `to` (both included), zero days included. */
export async function earnedPerDay(input: {
  from: string;
  to: string;
  dealId?: string;
  now?: Date;
}): Promise<{ zone: string; days: { day: string; cents: number }[] }> {
  const { from, to } = rangeSchema.parse(input);
  const l = await ledger(input.now);
  const total = new Map<string, number>();
  for (const deal of l.deals) {
    if (input.dealId && deal.id !== input.dealId) continue;
    for (const [day, cents] of earnedByDay(deal, l.earnings.get(deal.id)!)) {
      total.set(day, (total.get(day) ?? 0) + cents);
    }
  }
  return { zone: l.zone, days: dayKeysBetween(from, to).map((day) => ({ day, cents: total.get(day) ?? 0 })) };
}

export interface PostNeedingViews {
  postId: string;
  dealId: string;
  brandName: string;
  url: string;
  platform: Platform;
  postedAt: string;
  lastCapturedDay: string | null;
  latestViews: number | null;
}

/**
 * Today's work list for view readings: posts still inside their deal's freeze
 * window, not excluded, with no reading for today (owner zone). Oldest first.
 */
export async function postsNeedingViews(opts: { now?: Date } = {}): Promise<{
  today: string;
  posts: PostNeedingViews[];
}> {
  const l = await ledger(opts.now);
  const deals = new Map(l.deals.map((d) => [d.id, d]));
  const posts = l.posts
    .filter((p) => {
      const deal = deals.get(p.deal_id);
      if (!deal || p.exclude_from_pay || new Date(p.posted_at).getTime() > l.now.getTime()) return false;
      if (isViewsFrozen(new Date(p.posted_at), deal.view_freeze_days, l.now)) return false;
      return l.views.get(p.id)?.last_captured_day !== l.today;
    })
    .sort((a, b) => Date.parse(a.posted_at) - Date.parse(b.posted_at))
    .map((p) => {
      const v = l.views.get(p.id);
      return {
        postId: p.id,
        dealId: p.deal_id,
        brandName: deals.get(p.deal_id)!.brand_name,
        url: p.url,
        platform: p.platform,
        postedAt: p.posted_at,
        lastCapturedDay: v?.last_captured_day ?? null,
        latestViews: n(v?.latest_views),
      };
    });
  return { today: l.today, posts };
}

/** One owner-zone day on which some open posts got no view reading (the Grokbot missed-day warning). */
export interface MissedViewDay {
  day: string;
  needing: number;
  read: number;
}

/**
 * Days among the last `days` before today (owner zone) on which posts inside their freeze window got
 * no reading (public.ugc_missed_view_days, 0080_keys.sql). Empty when every open post was read.
 */
export async function missedViewDays(opts: { days?: number; now?: Date } = {}): Promise<MissedViewDay[]> {
  const db = await createServerClient();
  const { data, error } = await db.rpc("ugc_missed_view_days", {
    p_days: opts.days ?? 7,
    p_now: (opts.now ?? new Date()).toISOString(),
  });
  if (error) throw new Error(`UGC read failed: ${error.message}`);
  return ((data ?? []) as { day: string; posts_needing: number; posts_read: number }[]).map((r) => ({
    day: r.day,
    needing: Number(r.posts_needing),
    read: Number(r.posts_read),
  }));
}

/**
 * Suggested payouts (which open deposit pays which deal) and learned-rule offers. Confirm one with
 * confirmPayoutMatch; "Not this" with rejectPayoutMatch. Open deposits: the newest 300 positive, visible,
 * non-transfer transactions not matched to a deal (the same set the UGC page loads).
 */
export async function payoutMatches(opts: { now?: Date; dealId?: string } = {}): Promise<PayoutMatches & { today: string }> {
  const db = await createServerClient();
  const l = await loadLedger(db, opts.now ?? new Date());
  const [allPayments, open, rules, rejections] = await Promise.all([
    selectAll<{ deal_id: string; transaction_id: string; amount_cents: number; paid_on: string }>((a, b) =>
      db.from("deal_payments").select("deal_id, transaction_id, amount_cents, paid_on").order("id").range(a, b),
    ),
    db
      .from("transactions")
      .select("id, name, amount_cents, posted_on")
      .gt("amount_cents", 0)
      .eq("hidden", false)
      .eq("is_transfer", false)
      .order("posted_on", { ascending: false })
      .limit(300),
    selectAll<{ deal_id: string; payer_key: string; day_of_month: number | null; day_window: number; decision: "accepted" | "declined" }>(
      (a, b) => db.from("payout_rules").select("deal_id, payer_key, day_of_month, day_window, decision").order("id").range(a, b),
    ),
    selectAll<{ deal_id: string; transaction_id: string }>((a, b) =>
      db.from("payout_match_rejections").select("deal_id, transaction_id").order("deal_id").order("transaction_id").range(a, b),
    ),
  ]);
  if (open.error) throw new Error(`UGC read failed: ${open.error.message}`);
  // Every matched deposit stays out of the open set, but payer history is UGC deals only (as the page's).
  const matched = new Set(allPayments.map((p) => p.transaction_id));
  const ugcIds = new Set(l.deals.map((d) => d.id));
  const payments = allPayments.filter((p) => ugcIds.has(p.deal_id));
  const names = new Map<string, string>();
  for (let i = 0; i < payments.length; i += 100) {
    const ids = payments.slice(i, i + 100).map((p) => p.transaction_id);
    const { data, error } = await db.from("transactions").select("id, name").in("id", ids);
    if (error) throw new Error(`UGC read failed: ${error.message}`);
    for (const t of (data ?? []) as { id: string; name: string }[]) names.set(t.id, t.name);
  }
  const deals = opts.dealId ? l.deals.filter((d) => d.id === opts.dealId) : l.deals;
  const result = suggestPayoutMatches({
    today: l.today,
    deals: deals.map((d) => matchDealOf(d, l.earnings.get(d.id)!)),
    payments: payments.map((p) => ({
      dealId: p.deal_id,
      transactionId: p.transaction_id,
      amountCents: Number(p.amount_cents),
      paidOn: p.paid_on,
      name: names.get(p.transaction_id) ?? null,
    })),
    deposits: ((open.data ?? []) as { id: string; name: string; amount_cents: number; posted_on: string }[])
      .filter((t) => !matched.has(t.id))
      .map((t) => ({ id: t.id, name: t.name, amountCents: Number(t.amount_cents), postedOn: t.posted_on })),
    rules: rules.map((r) => ({
      dealId: r.deal_id,
      payerKey: r.payer_key,
      dayOfMonth: r.day_of_month,
      dayWindow: r.day_window,
      decision: r.decision,
    })),
    rejections: rejections.map((r) => ({ dealId: r.deal_id, transactionId: r.transaction_id })),
  });
  return { today: l.today, ...result };
}
