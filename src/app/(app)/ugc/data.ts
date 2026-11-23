import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";

import type {
  AccountRaw,
  DayTargetRaw,
  DepositRaw,
  PaymentRaw,
  PayoutRejectionRaw,
  PayoutRuleRaw,
  PostRaw,
  PostViewRaw,
  SnapshotRaw,
  TemplateRaw,
  UgcRaw,
} from "@/components/ugc/types";
import { createServerClient } from "@/lib/supabase/server";
import type { WithEngagement } from "@/lib/ugc/analytics";
import { readLatestEngagement } from "@/lib/ugc/analytics-queries";
import { addDays, dayKeyInZone } from "@/lib/ugc/days";
import { ugcDealsOnly } from "@/lib/ugc/personal";
import type { DealDbRow } from "@/lib/ugc/schemas";
import { zoneOf } from "@/lib/ugc/writes";

/** Readings older than this are not loaded: the sparkline and day panel need weeks; the pay math uses `ugc_post_views`. */
const READING_DAYS = 45;
const PAGE = 1000;
/** Signed logo URLs live this long (seconds). The page reads them again on every visit. */
const LOGO_TTL = 3600;

type Page = PromiseLike<{ data: unknown[] | null; error: PostgrestError | null }>;

async function selectAll<T>(page: (from: number, to: number) => Page): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`UGC read failed: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

const POST_COLUMNS =
  "id, deal_id, account_id, url, platform, title, posted_at, video_group_id, video_group_manual, exclude_from_pay, manual_override_cents, " +
  "base_pay_cents_snap, base_min_views_snap, view_bonuses_snap, view_bonus_mode_snap, cpm_rate_snap, " +
  "cpm_view_unit_snap, cpm_cap_views_snap, cpm_min_views_snap, cpm_tiers_snap, cpm_mode_snap, cpm_tier_mode_snap";

/**
 * Everything the UGC Tracker shows, read as the signed-in owner (RLS: anyone else reads nothing). The UGC tables
 * must load; bank names, open deposits and logo URLs are extras that fall back to empty. Nothing is priced here:
 * the page computes money with the ledger.
 */
export async function loadUgcRaw(): Promise<UgcRaw & WithEngagement> {
  const db = await createServerClient();
  const zone = await zoneOf(db);
  const since = addDays(dayKeyInZone(new Date(), zone), -READING_DAYS);
  // Likes and comments for the analytics start with the rest. An extra: a failed read shows the tiles empty.
  const engagementRead = readLatestEngagement(db).catch(() => []);
  const [dealRows, allAccounts, allPosts, allViews, allSnapshots, allPayments, allDayTargets, templates] = await Promise.all([
    // The Personal Brand deal lives on /brand; ugcDealsOnly drops it and its rows below (a database from before 0140, with no column, still loads).
    selectAll<DealDbRow>((a, b) => db.from("deals").select("*").order("id").range(a, b)),
    selectAll<AccountRaw>((a, b) => db.from("deal_accounts").select("id, deal_id, platform, handle").order("id").range(a, b)),
    selectAll<PostRaw>((a, b) => db.from("posts").select(POST_COLUMNS).order("id").range(a, b)),
    selectAll<PostViewRaw>((a, b) =>
      db
        .from("ugc_post_views")
        .select("post_id, payable_views, latest_views, last_captured_at, last_captured_day, latest_held")
        .order("post_id")
        .range(a, b),
    ),
    selectAll<SnapshotRaw>((a, b) =>
      db
        .from("post_view_snapshots")
        .select("post_id, captured_day, captured_at, views, held")
        .gte("captured_day", since)
        .order("id")
        .range(a, b),
    ),
    selectAll<Omit<PaymentRaw, "name">>((a, b) =>
      db.from("deal_payments").select("id, deal_id, transaction_id, amount_cents, paid_on").order("id").range(a, b),
    ),
    selectAll<DayTargetRaw>((a, b) => db.from("day_targets").select("deal_id, day, target").order("deal_id").order("day").range(a, b)),
    selectAll<TemplateRaw>((a, b) => db.from("deal_templates").select("*").eq("archived", false).order("id").range(a, b)),
  ]);

  const { deals, has } = ugcDealsOnly(dealRows);
  const posts = allPosts.filter(has);
  const postIds = new Set(posts.map((p) => p.id));
  const accounts = allAccounts.filter(has);
  const views = allViews.filter((v) => postIds.has(v.post_id));
  const snapshots = allSnapshots.filter((s) => postIds.has(s.post_id));
  const payments = allPayments.filter(has);
  const dayTargets = allDayTargets.filter(has);

  // The extras, all at once. Bank names for matched deposits and the deposits still open (absent or failing:
  // empty), the missed-day warning (Grokbot left open posts unread on these days), and signed logo URLs.
  // Every matched deposit, Personal Brand ones too, so none shows again as open.
  const matched = new Set(allPayments.map((p) => p.transaction_id));
  const paths = [...new Set([...deals, ...templates].flatMap((d) => (d.logo_path ? [d.logo_path] : [])))];
  const chunks: string[][] = [];
  for (let i = 0; i < payments.length; i += 100) chunks.push(payments.slice(i, i + 100).map((p) => p.transaction_id));
  const [named, open, gaps, signed, engagement, rejections, rules] = await Promise.all([
    Promise.all(chunks.map((ids) => db.from("transactions").select("id, name").in("id", ids))),
    db
      .from("transactions")
      .select("id, name, amount_cents, posted_on")
      .gt("amount_cents", 0)
      .eq("hidden", false)
      .eq("is_transfer", false)
      .order("posted_on", { ascending: false })
      .limit(300),
    db.rpc("ugc_missed_view_days", { p_days: 7 }),
    paths.length > 0 ? db.storage.from("deal-logos").createSignedUrls(paths, LOGO_TTL) : null,
    engagementRead,
    db.from("payout_match_rejections").select("deal_id, transaction_id").limit(5000),
    db.from("payout_rules").select("deal_id, payer_key, day_of_month, day_window, decision").limit(1000),
  ]);

  const names = new Map<string, string>();
  for (const { data } of named) for (const t of (data ?? []) as { id: string; name: string }[]) names.set(t.id, t.name);
  const deposits = ((open.data ?? []) as DepositRaw[]).filter((d) => !matched.has(d.id)).slice(0, 200);
  const missedViewDays = ((gaps.data ?? []) as { day: string; posts_needing: number; posts_read: number }[]).map((r) => ({
    day: r.day,
    needing: Number(r.posts_needing),
    read: Number(r.posts_read),
  }));
  const logos: Record<string, string> = {};
  for (const s of signed?.data ?? []) if (s.path && s.signedUrl) logos[s.path] = s.signedUrl;

  return {
    engagement,
    nowIso: new Date().toISOString(),
    zone,
    deals,
    accounts,
    posts,
    views,
    snapshots,
    payments: payments.map((p) => ({ ...p, name: names.get(p.transaction_id) ?? null })),
    dayTargets,
    templates,
    deposits,
    payoutRejections: (rejections.data ?? []) as PayoutRejectionRaw[],
    payoutRules: (rules.data ?? []) as PayoutRuleRaw[],
    logos,
    missedViewDays,
  };
}
