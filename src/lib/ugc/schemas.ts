/**
 * Input schemas and boundary helpers for the UGC actions. Every write (a page,
 * the Hydra Agent, the Grokbot connector) is validated here first.
 * Money in = integer cents. CPM rates are dollars per view unit (4 decimals).
 */
import { z } from "zod";
import {
  DUPLICATE_VIEWS_MESSAGE,
  FLAT_DECREASING_RATE_MESSAGE,
  MAX_PAY_RATE,
  MAX_PAY_VIEWS,
  hasUniqueViewThresholds,
  violatesFlatMonotonicRates,
} from "@/lib/ugc/pay-validation";
import { DAY_KEY_REGEX, MONTH_KEY_REGEX } from "@/lib/ugc/days";
import type { BonusTierCents, DealStatus, PausedSpan } from "@/lib/ugc/ledger";
import type { CpmTier } from "@/lib/ugc/pay-cpm";

export const PLATFORMS = ["INSTAGRAM", "TIKTOK", "YOUTUBE", "FACEBOOK"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const TIER_MODES = ["PER_VIDEO", "COMBINED_BRACKETED", "COMBINED_FLAT"] as const;
export const PAY_CYCLES = ["WEEKLY", "BIWEEKLY", "MONTHLY", "DAYS_OF_MONTH"] as const;

/** Largest view reading accepted (a post can pass the 1e9 threshold cap). */
export const MAX_VIEW_READING = 100_000_000_000;

const cents = z.number().int().min(0).max(MAX_PAY_RATE * 100);
const thresholdViews = z.number().int().min(0).max(MAX_PAY_VIEWS);
const reading = z.number().int().min(0).max(MAX_VIEW_READING);
export const dayKeySchema = z.string().regex(DAY_KEY_REGEX, "Use YYYY-MM-DD");
export const monthKeySchema = z.string().regex(MONTH_KEY_REGEX, "Use YYYY-MM");
const rate = z
  .number()
  .min(0)
  .max(MAX_PAY_RATE)
  .transform((v) => Math.round(v * 10_000) / 10_000);
const instant = z.iso.datetime({ offset: true });

// ─── URLs, handles, payout rules ─────────────────────────────────────────────

/**
 * One canonical form per post, so the unique index catches the same post sent
 * twice: https, lower-case host without www./m., no query or hash (share links
 * add tracking params), no trailing slash. YouTube keeps its `v` id; youtu.be
 * becomes youtube.com/watch?v=. Facebook's watch, story.php and permalink.php
 * links keep the query keys that carry the video id (v; story_fbid and id).
 * The path keeps its case (post ids are case-sensitive).
 * Returns null for anything that is not an http(s) URL.
 */
const FACEBOOK_ID_KEYS: Record<string, readonly string[]> = {
  "/watch": ["v"],
  "/story.php": ["story_fbid", "id"],
  "/permalink.php": ["story_fbid", "id"],
};

export function normalizePostUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  if (host === "youtu.be") return path.length > 1 ? `https://youtube.com/watch?v=${path.slice(1)}` : null;
  if (host === "youtube.com" && path === "/watch") {
    const v = u.searchParams.get("v");
    return v ? `https://youtube.com/watch?v=${v}` : null;
  }
  const fbKeys = host === "facebook.com" ? FACEBOOK_ID_KEYS[path] : undefined;
  if (fbKeys) {
    const q = new URLSearchParams();
    for (const k of fbKeys) {
      const v = u.searchParams.get(k);
      if (!v) return null;
      q.set(k, v);
    }
    return `https://${host}${path}?${q}`;
  }
  return `https://${host}${path}`;
}

/** "@Name " → "name". */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

const postUrl = z
  .string()
  .max(2000)
  .transform((v, ctx) => {
    const url = normalizePostUrl(v);
    if (!url) {
      ctx.addIssue({ code: "custom", message: "Not a post URL" });
      return z.NEVER;
    }
    return url;
  });

const handle = z.string().transform(normalizeHandle).pipe(z.string().min(1).max(100));

export const payoutRuleSchema = z
  .object({
    /** Case-insensitive substring of the deposit's name or payer. */
    payerContains: z.string().trim().min(1).max(200).optional(),
    minCents: cents.optional(),
    maxCents: cents.optional(),
  })
  .strict();
export type PayoutRule = z.infer<typeof payoutRuleSchema>;

/** True when a deposit fits the deal's payout rule. An empty rule matches nothing. */
export function matchesPayoutRule(
  rule: PayoutRule,
  deposit: { name: string; amountCents: number },
): boolean {
  if (!rule.payerContains && rule.minCents === undefined && rule.maxCents === undefined) return false;
  if (deposit.amountCents <= 0) return false;
  if (rule.payerContains && !deposit.name.toLowerCase().includes(rule.payerContains.toLowerCase())) return false;
  if (rule.minCents !== undefined && deposit.amountCents < rule.minCents) return false;
  if (rule.maxCents !== undefined && deposit.amountCents > rule.maxCents) return false;
  return true;
}

// ─── Deals ───────────────────────────────────────────────────────────────────

const bonusTier = z.object({ views: thresholdViews.min(1), bonusCents: cents });
const cpmTier = z.object({ views: thresholdViews.min(1), ratePerUnit: rate });

const dealObject = z.object({
  brandName: z.string().trim().min(1).max(200),
  logoPath: z.string().trim().min(1).max(500).nullable(),
  startDate: dayKeySchema,
  endDate: dayKeySchema.nullable(),
  /** Off = pay per video (calcPay). On = Ripple's per-deal aggregate. */
  perDealModel: z.boolean(),
  basePayCents: cents.nullable(),
  baseMinViews: thresholdViews,
  viewBonuses: z.array(bonusTier).max(50).refine(hasUniqueViewThresholds, DUPLICATE_VIEWS_MESSAGE),
  viewBonusMode: z.enum(["REPLACE", "ADD"]),
  cpmRate: rate.nullable(),
  cpmViewUnit: z.number().int().min(1).max(MAX_PAY_VIEWS),
  cpmCapViews: thresholdViews.nullable(),
  /** The CPM floor: views below it pay no CPM (Ripple cpmMinViews). */
  cpmMinViews: thresholdViews.nullable(),
  cpmTiers: z.array(cpmTier).max(50).refine(hasUniqueViewThresholds, DUPLICATE_VIEWS_MESSAGE),
  cpmMode: z.enum(["ADD", "REPLACE"]),
  cpmTierMode: z.enum(TIER_MODES),
  viewAggregationMode: z.enum(["HIGHEST", "COMBINED"]),
  viewFreezeDays: z.number().int().min(1).max(365).nullable(),
  retainerCents: cents.nullable(),
  flatRateCents: cents.nullable(),
  dailyTargetPosts: z.number().int().min(0).max(30),
  payCycle: z.enum(PAY_CYCLES).nullable(),
  payCycleAnchorDay: z.number().int().min(1).max(31).nullable(),
  payCycleAnchorWeekday: z.number().int().min(0).max(6).nullable(),
  payCycleAnchorDays: z.array(z.number().int().min(1).max(31)).max(31),
  payoutRule: payoutRuleSchema,
});
export type DealInput = z.infer<typeof dealObject>;

/** Values a new deal starts with (Ripple's column defaults; one video a day). */
export const DEAL_DEFAULTS: Omit<DealInput, "brandName" | "startDate"> = {
  logoPath: null,
  endDate: null,
  perDealModel: false,
  basePayCents: null,
  baseMinViews: 0,
  viewBonuses: [],
  viewBonusMode: "REPLACE",
  cpmRate: null,
  cpmViewUnit: 1000,
  cpmCapViews: null,
  cpmMinViews: null,
  cpmTiers: [],
  cpmMode: "ADD",
  cpmTierMode: "PER_VIDEO",
  viewAggregationMode: "HIGHEST",
  viewFreezeDays: null,
  retainerCents: null,
  flatRateCents: null,
  dailyTargetPosts: 1,
  payCycle: null,
  payCycleAnchorDay: null,
  payCycleAnchorWeekday: null,
  payCycleAnchorDays: [],
  payoutRule: {},
};

/** The whole pay structure, checked as one: dates in order, no COMBINED_FLAT cliff. */
export const dealSchema = dealObject.superRefine((d, ctx) => {
  if (d.endDate && d.endDate < d.startDate) {
    ctx.addIssue({ code: "custom", path: ["endDate"], message: "End date is before the start date" });
  }
  if (
    d.cpmTierMode === "COMBINED_FLAT" &&
    violatesFlatMonotonicRates({ cpmRate: d.cpmRate, cpmTiers: d.cpmTiers })
  ) {
    ctx.addIssue({ code: "custom", path: ["cpmTiers"], message: FLAT_DECREASING_RATE_MESSAGE });
  }
  const { minCents, maxCents } = d.payoutRule;
  if (minCents !== undefined && maxCents !== undefined && minCents > maxCents) {
    ctx.addIssue({ code: "custom", path: ["payoutRule"], message: "Minimum is above maximum" });
  }
});

/** Create: brand name and start date, plus any field to change from DEAL_DEFAULTS. */
export const createDealSchema = dealObject.partial().extend({
  brandName: dealObject.shape.brandName,
  startDate: dayKeySchema,
  /** App writes are always "hydra"; only the Ripple import (database owner, SQL) writes "ripple" rows. A source id makes a rerun idempotent. */
  source: z.literal("hydra").default("hydra"),
  sourceId: z.string().trim().min(1).max(200).nullable().default(null),
});

/** Update: the deal id plus any fields to change. The merged result is re-checked whole. */
export const updateDealSchema = dealObject.partial().extend({ id: z.uuid() });
export const dealIdSchema = z.object({ id: z.uuid() });
export const endDealSchema = z.object({ id: z.uuid(), endDate: dayKeySchema.optional() });

/** The `public.deals` row a DealInput writes. */
export function dealInputToRow(d: DealInput) {
  return {
    brand_name: d.brandName,
    logo_path: d.logoPath,
    start_date: d.startDate,
    end_date: d.endDate,
    per_deal_model: d.perDealModel,
    base_pay_cents: d.basePayCents,
    base_min_views: d.baseMinViews,
    view_bonuses: d.viewBonuses,
    view_bonus_mode: d.viewBonusMode,
    cpm_rate: d.cpmRate,
    cpm_view_unit: d.cpmViewUnit,
    cpm_cap_views: d.cpmCapViews,
    cpm_min_views: d.cpmMinViews,
    cpm_tiers: d.cpmTiers,
    cpm_mode: d.cpmMode,
    cpm_tier_mode: d.cpmTierMode,
    view_aggregation_mode: d.viewAggregationMode,
    view_freeze_days: d.viewFreezeDays,
    retainer_cents: d.retainerCents,
    flat_rate_cents: d.flatRateCents,
    daily_target_posts: d.dailyTargetPosts,
    pay_cycle: d.payCycle,
    pay_cycle_anchor_day: d.payCycleAnchorDay,
    pay_cycle_anchor_weekday: d.payCycleAnchorWeekday,
    pay_cycle_anchor_days: d.payCycleAnchorDays,
    payout_rule: d.payoutRule,
  };
}

/** The full `public.deals` row as stored. */
export type DealDbRow = ReturnType<typeof dealInputToRow> & {
  id: string;
  entity_id: string;
  status: DealStatus;
  view_bonuses: BonusTierCents[];
  cpm_tiers: CpmTier[];
  cpm_rate: number | string | null;
  source: "hydra" | "ripple";
  source_id: string | null;
  /** Pauses, written by the deals_track_pause trigger. */
  paused_spans?: PausedSpan[];
  /** The owner's own account (0140): its posts show on /brand, never in the UGC tracker or its money. */
  personal_brand?: boolean;
  created_at: string;
  updated_at: string;
};

/** A stored deal row back in input form (for update merges). */
export function dealRowToInput(r: DealDbRow): DealInput {
  return {
    brandName: r.brand_name,
    logoPath: r.logo_path,
    startDate: r.start_date,
    endDate: r.end_date,
    perDealModel: r.per_deal_model,
    basePayCents: r.base_pay_cents === null ? null : Number(r.base_pay_cents),
    baseMinViews: r.base_min_views,
    viewBonuses: r.view_bonuses ?? [],
    viewBonusMode: r.view_bonus_mode,
    cpmRate: r.cpm_rate === null ? null : Number(r.cpm_rate),
    cpmViewUnit: r.cpm_view_unit,
    cpmCapViews: r.cpm_cap_views,
    cpmMinViews: r.cpm_min_views,
    cpmTiers: r.cpm_tiers ?? [],
    cpmMode: r.cpm_mode,
    cpmTierMode: r.cpm_tier_mode,
    viewAggregationMode: r.view_aggregation_mode,
    viewFreezeDays: r.view_freeze_days,
    retainerCents: r.retainer_cents === null ? null : Number(r.retainer_cents),
    flatRateCents: r.flat_rate_cents === null ? null : Number(r.flat_rate_cents),
    dailyTargetPosts: r.daily_target_posts,
    payCycle: r.pay_cycle,
    payCycleAnchorDay: r.pay_cycle_anchor_day,
    payCycleAnchorWeekday: r.pay_cycle_anchor_weekday,
    payCycleAnchorDays: r.pay_cycle_anchor_days ?? [],
    payoutRule: r.payout_rule ?? {},
  };
}

// ─── Posts and views ─────────────────────────────────────────────────────────

export const addPostSchema = z.object({
  dealId: z.uuid(),
  url: postUrl,
  platform: z.enum(PLATFORMS),
  /** The account handle; created on the deal if new. */
  account: handle.optional(),
  postedAt: instant,
  /** Posts sharing this id are one video, paid once (Grokbot sends it). */
  videoGroupId: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().max(500).optional(),
  source: z.enum(["hydra", "grokbot"]).default("hydra"),
});

export const editPostSchema = z.object({
  id: z.uuid(),
  dealId: z.uuid().optional(),
  url: postUrl.optional(),
  platform: z.enum(PLATFORMS).optional(),
  account: handle.nullable().optional(),
  postedAt: instant.optional(),
  videoGroupId: z.string().trim().min(1).max(200).nullable().optional(),
  title: z.string().trim().max(500).nullable().optional(),
  /** The owner's own price for this video; null clears it. */
  manualOverrideCents: cents.nullable().optional(),
});

export const postIdSchema = z.object({ id: z.uuid() });

/** Link posts of one deal as one video (paid once). Their groups merge into one. */
export const linkPostsSchema = z.object({ postIds: z.array(z.uuid()).min(2).max(50) });

/** Take a post out of its video; the matcher never links it again. */
export const unlinkPostSchema = z.object({ postId: z.uuid() });

export const setViewsSchema = z.object({
  capturedAt: instant,
  /** Skips the lower-count and jump guards (owner review). Never skips the freeze. */
  force: z.boolean().default(false),
  items: z
    .array(
      z
        .object({
          postId: z.uuid().optional(),
          url: postUrl.optional(),
          views: reading,
          likes: reading.nullable().optional(),
          comments: reading.nullable().optional(),
        })
        .refine((i) => (i.postId === undefined) !== (i.url === undefined), "Give postId or url, not both"),
    )
    .min(1)
    .max(500),
});

// ─── Day targets and payments ────────────────────────────────────────────────

export const setDayTargetSchema = z.object({
  dealId: z.uuid(),
  day: dayKeySchema,
  /** 0 = a day off (no missed money). null removes the override. */
  target: z.number().int().min(0).max(30).nullable(),
});

export const matchPaymentSchema = z.object({
  dealId: z.uuid(),
  /** The bank transaction (U2). One transaction links to one deal. */
  transactionId: z.uuid(),
  amountCents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  paidOn: dayKeySchema,
});

export const unmatchPaymentSchema = z.object({ transactionId: z.uuid() });

/** A suggested payout (src/lib/ugc/payout-match.ts): confirm it, or say "Not this". */
export const payoutPairSchema = z.object({ dealId: z.uuid(), transactionId: z.uuid() });

/** One rule answer: a deal and a payer (public.payout_rules is unique on both). */
export const payoutRuleKeySchema = z.object({ dealId: z.uuid(), payerKey: z.string().trim().min(1).max(200) });

/** A learned payout rule, kept or turned down (public.payout_rules). */
export const decidePayoutRuleSchema = z.object({
  dealId: z.uuid(),
  payerKey: z.string().trim().min(1).max(200),
  dayOfMonth: z.number().int().min(1).max(31).nullable(),
  decision: z.enum(["accepted", "declined"]),
});

// ─── Results ─────────────────────────────────────────────────────────────────

export type ActionErrorCode =
  | "invalid_input"
  | "not_owner"
  | "not_found"
  | "conflict"
  | "rejected"
  | "db_error";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ActionErrorCode; message: string; issues?: { path: string; message: string }[] } };

/** A zod failure as an invalid_input result. */
export function invalidInput(error: z.ZodError): ActionResult<never> {
  return {
    ok: false,
    error: {
      code: "invalid_input",
      message: error.issues[0]?.message ?? "Invalid input",
      issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    },
  };
}
