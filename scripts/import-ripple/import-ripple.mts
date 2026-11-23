/**
 * One-time Ripple import (U16, DESIGN.md section 8). Reads the owner's Ripple export (JSON files
 * written by a read-only export) and writes Hydra rows, insert-only: a rerun inserts only what is
 * new and never updates or brings back a row (the owner's edits and deletions stay).
 *
 *   node scripts/import-ripple/import-ripple.mts <exportDir> [--zone <IANA>]
 *     [--write --out <dir> [--db-url <postgres url> | --local] [--max-bytes <n>] [--env <file>]]
 *
 * Without --write it is a dry run: it prints counts per table and changes nothing.
 * --write writes SQL files that call private.ripple_import_apply (0011), each one transaction
 * holding whole deals. Only the database owner role can run them (no API key can). With --db-url
 * it runs them with psql; with --local through `supabase db query` on the local stack; it never
 * runs against the hosted project itself, it prints the hosted command. Logos go to the private
 * deal-logos bucket when NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are set (--env): Storage
 * only. Day keys use --zone, else the settings.time_zone of --db-url; --write needs one of them.
 *
 * Mapping:
 *   Ripple master campaigns -> deal_templates (the "already created" list the owner adds from),
 *                              whoever owns them (brand or other admin). Pay tiers are cleaned to
 *                              what dealSchema accepts, so an imported deal stays editable.
 *   His other campaigns     -> deals (archived = ended), accounts -> deal_accounts (no OAuth).
 *   Another user's non-master campaigns are skipped with a warning.
 *   PlatformPost            -> posts with Ripple's rate snapshot columns, exclude flag and manual
 *                              override (kept because the database owner inserts them);
 *                              UnifiedVideo -> video_group_id.
 *   PostViewSnapshot        -> post_view_snapshots, the last reading of each owner-zone day.
 *   Logos (Ripple storage, served by its media CDN) -> deal-logos at 'ripple/<Ripple path>';
 *   downloads are cached in <exportDir>/logos.
 *   Every imported Ripple id is recorded in import_ripple_map (the rerun ledger).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ─── Export shape (only the fields the import reads) ─────────────────────────

type Num = number | string | null;
interface RippleCampaign {
  id: string;
  userId: string;
  name: string;
  logo: string | null;
  brandId: string | null;
  isMaster: boolean;
  masterCampaignId: string | null;
  archivedAt: string | null;
  createdAt: string;
  paymentPerVideo: Num;
  basePayMinViews: number | null;
  viewBonuses: unknown;
  viewBonusMode: string | null;
  cpmRate: Num;
  cpmViewUnit: number | null;
  cpmCapViews: number | null;
  cpmMinViews: number | null;
  cpmTiers: unknown;
  cpmMode: string | null;
  tierEvaluationMode: string | null;
  viewAggregationMode: string | null;
  viewFreezeDays: number | null;
  retainerEnabled: boolean;
  retainerAmount: Num;
  flatRateEnabled: boolean;
  flatRateAmount: Num;
  dailyVideos: number | null;
  payCycleFrequency: string | null;
  payCycleAnchorDay: number | null;
  payCycleAnchorWeekday: number | null;
  payCycleAnchorDays: number[] | null;
}
interface RippleAccount {
  id: string;
  platform: string;
  platformUserId: string;
  username: string;
  campaignId: string | null;
}
interface RipplePost {
  id: string;
  connectedAccountId: string;
  platformPostId: string;
  platform: string;
  caption: string | null;
  permalinkUrl: string | null;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  postedAt: string;
  createdAt: string;
  updatedAt: string;
  viewsSyncedAt: string | null;
  excludeFromEarnings: boolean;
  markedIrrelevantAt: string | null;
  manualEarningsOverride: Num;
  paymentPerVideoSnapshot: Num;
  basePayMinViewsSnapshot: number | null;
  viewBonusesSnapshot: unknown;
  viewBonusModeSnapshot: string | null;
  cpmRateSnapshot: Num;
  cpmViewUnitSnapshot: number | null;
  cpmCapViewsSnapshot: number | null;
  cpmMinViewsSnapshot: number | null;
  cpmTiersSnapshot: unknown;
  cpmModeSnapshot: string | null;
  tierEvaluationModeSnapshot: string | null;
}
interface RippleSnapshot {
  id: string;
  platformPostId: string;
  views: number;
  likes: number | null;
  comments: number | null;
  capturedAt: string;
}
export interface RippleExport {
  owner: { id: string; email: string };
  site: { viewFreezeDays: number | null };
  campaigns: RippleCampaign[];
  brands: { id: string; brandName: string | null; brandLogo: string | null }[];
  foreign_masters: { id: string; name: string; logo: string | null }[];
  accounts: RippleAccount[];
  posts: RipplePost[];
  snapshots: RippleSnapshot[];
  unified_links: { unifiedVideoId: string; platformPostId: string }[];
}

const FILES = [
  "owner", "site", "campaigns", "brands", "foreign_masters", "accounts", "posts", "snapshots", "unified_links",
] as const;

export function readExport(dir: string): RippleExport {
  const out: Record<string, unknown> = {};
  for (const f of FILES) out[f] = JSON.parse(readFileSync(join(dir, `${f}.json`), "utf8"));
  return out as unknown as RippleExport;
}

// ─── Small converters ────────────────────────────────────────────────────────

const PLATFORMS = ["INSTAGRAM", "TIKTOK", "YOUTUBE", "FACEBOOK"];
const PAY_CYCLES = ["WEEKLY", "BIWEEKLY", "MONTHLY", "DAYS_OF_MONTH"];
const DEFAULT_FREEZE_DAYS = 14;
const DAY_MS = 86_400_000;

/** Prisma DateTime comes out of Postgres as UTC without a zone mark. */
export function utc(ts: string): Date {
  return new Date(/(Z|[+-]\d\d:?\d\d)$/.test(ts) ? ts : `${ts}Z`);
}

const formatters = new Map<string, Intl.DateTimeFormat>();
/** "YYYY-MM-DD" of `at` in `zone`. */
export function dayKey(at: Date, zone: string): string {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(zone, f);
  }
  return f.format(at);
}

function isZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Dollars (Decimal(12,2)) to whole cents. */
export function cents(v: Num | undefined): number | null {
  return v === null || v === undefined ? null : Math.round(Number(v) * 100);
}

// Limits of dealSchema (src/lib/ugc/schemas.ts, pay-validation.ts). The test runs imported rows
// through the real schema, so a drift shows up there.
const MAX_VIEWS = 1_000_000_000;
const MAX_RATE = 1_000_000;
const MAX_CENTS = MAX_RATE * 100;
const MAX_TIERS = 50;

/** v rounded and clamped into [min, max]; null when v is missing or not a number. */
function clampInt(v: Num | undefined, min: number, max: number): number | null {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  return Math.min(max, Math.max(min, Math.round(Number(v))));
}

/** A rate kept at 4 decimals, as text so numeric(12,4) gets it exactly. Null when missing or negative. */
function rate(v: Num | undefined): string | null {
  if (v === null || v === undefined || !Number.isFinite(Number(v)) || Number(v) < 0) return null;
  return Math.min(Number(v), MAX_RATE).toFixed(4);
}

function oneOf<T extends string | null>(v: string | null | undefined, allowed: string[], fallback: T): string | T {
  return v && allowed.includes(v) ? v : fallback;
}

/** Ascending, one entry per views threshold (the first in export order wins), at most 50. */
function uniqueAscending<T extends { views: number }>(rows: T[]): T[] {
  const seen = new Set<number>();
  return rows.filter((t) => !seen.has(t.views) && seen.add(t.views)).sort((a, b) => a.views - b.views).slice(0, MAX_TIERS);
}

/**
 * Ripple [{views, bonus (dollars)}] -> Hydra [{views, bonusCents}], ascending. Junk, negative
 * bonuses and repeated thresholds are dropped, so the table passes dealSchema.
 */
export function bonusesToCents(v: unknown): { views: number; bonusCents: number }[] {
  if (!Array.isArray(v)) return [];
  return uniqueAscending(
    v
      .filter((t) => Number.isFinite(Number(t?.views)) && Number(t.views) >= 1 && Number.isFinite(Number(t?.bonus)) && Number(t.bonus) >= 0)
      .map((t) => ({ views: clampInt(t.views, 1, MAX_VIEWS)!, bonusCents: clampInt(Number(t.bonus) * 100, 0, MAX_CENTS)! })),
  );
}

/** Ripple [{views, ratePerUnit}], ascending. Same cleaning as bonusesToCents; rates keep 4 decimals. */
export function cpmTiers(v: unknown): { views: number; ratePerUnit: number }[] {
  if (!Array.isArray(v)) return [];
  return uniqueAscending(
    v
      .filter((t) => Number.isFinite(Number(t?.views)) && Number(t.views) >= 1 && Number.isFinite(Number(t?.ratePerUnit)) && Number(t.ratePerUnit) >= 0)
      .map((t) => ({
        views: clampInt(t.views, 1, MAX_VIEWS)!,
        ratePerUnit: Math.round(Math.min(Number(t.ratePerUnit), MAX_RATE) * 10_000) / 10_000,
      })),
  );
}

// Copies of normalizePostUrl / normalizeHandle in src/lib/ugc/schemas.ts (this script runs under
// plain Node, which cannot resolve the "@/" alias). import-ripple.test.ts fails if they drift.
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

export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

/**
 * The post's public URL, built the way Ripple built it (lib/platform-display.ts
 * getPlatformVideoUrl): the stored permalink first, else from the platform id and handle.
 * Null when Ripple could not build a working URL either (an Instagram Graph numeric id).
 */
export function rippleVideoUrl(post: RipplePost, username: string): string | null {
  const permalink = (post.permalinkUrl ?? "").trim();
  if (/^https?:\/\//i.test(permalink)) return permalink;
  const id = post.platformPostId;
  if (!id || /^v_pub_[a-z]*~/i.test(id)) return null;
  switch (post.platform) {
    case "INSTAGRAM":
      return /^[A-Za-z0-9_-]+$/.test(id) && !/^\d+$/.test(id) ? `https://www.instagram.com/reel/${id}/` : null;
    case "TIKTOK": {
      const u = username.trim().replace(/^@/, "");
      return u ? `https://www.tiktok.com/@${u}/video/${id}` : null;
    }
    case "YOUTUBE":
      return `https://youtu.be/${id}`;
    case "FACEBOOK":
      return `https://www.facebook.com/reel/${id}`;
    default:
      return null;
  }
}

/** Hydra object path for a Ripple logo (a storage path, or a full URL). */
export function logoObjectPath(source: string): string {
  return `ripple/${source.replace(/^https?:\/\//, "")}`;
}

/** A safe Ripple logo reference: letters, digits, ._-/ and no "..". */
function safeLogo(source: string | null | undefined): string | null {
  if (!source) return null;
  const s = source.trim().replace(/^\/+/, "");
  return /^(https?:\/\/)?[A-Za-z0-9._\-/]+$/.test(s) && !s.includes("..") ? s : null;
}

// ─── The plan: every Hydra row the import writes, before any id is known ─────

type Row = Record<string, unknown>;
export interface PlanItem {
  /** The natural key the database upserts on, as text. */
  key: string;
  rippleIds: string[];
  row: Row;
}
export interface PostItem extends PlanItem {
  dealKey: string;
  accountKey: string;
}
export interface SnapshotItem extends PlanItem {
  postKey: string;
  synthetic: boolean;
}
export interface Plan {
  zone: string;
  templates: PlanItem[];
  deals: PlanItem[];
  accounts: (PlanItem & { dealKey: string })[];
  posts: PostItem[];
  snapshots: SnapshotItem[];
  /** Hydra object path -> Ripple logo reference. */
  logos: Map<string, string>;
  /** How every exported row was used: export count = the sum of its parts. */
  ledger: Record<string, { exported: number; parts: Record<string, number> }>;
  /** Rows imported with a caveat, or left out on purpose. Printed, never fatal. */
  warnings: string[];
}

/** The pay columns a deal and a template share. */
function payStructure(c: RippleCampaign, siteFreezeDays: number | null): Row {
  const days = [...new Set((c.payCycleAnchorDays ?? []).map((d) => clampInt(d, 1, 31)).filter((d): d is number => d !== null))].sort((a, b) => a - b);
  return {
    per_deal_model: false,
    base_pay_cents: clampInt(cents(c.paymentPerVideo), 0, MAX_CENTS),
    base_min_views: clampInt(c.basePayMinViews, 0, MAX_VIEWS) ?? 0,
    view_bonuses: bonusesToCents(c.viewBonuses),
    view_bonus_mode: oneOf(c.viewBonusMode, ["REPLACE", "ADD"], "REPLACE"),
    cpm_rate: rate(c.cpmRate),
    cpm_view_unit: c.cpmViewUnit && c.cpmViewUnit > 0 ? clampInt(c.cpmViewUnit, 1, MAX_VIEWS) : 1000,
    cpm_cap_views: clampInt(c.cpmCapViews, 0, MAX_VIEWS),
    cpm_min_views: clampInt(c.cpmMinViews, 0, MAX_VIEWS),
    cpm_tiers: cpmTiers(c.cpmTiers),
    cpm_mode: oneOf(c.cpmMode, ["ADD", "REPLACE"], "ADD"),
    cpm_tier_mode: oneOf(c.tierEvaluationMode, ["PER_VIDEO", "COMBINED_BRACKETED", "COMBINED_FLAT"], "PER_VIDEO"),
    view_aggregation_mode: oneOf(c.viewAggregationMode, ["HIGHEST", "COMBINED"], "HIGHEST"),
    // Ripple null = the site setting.
    view_freeze_days: clampInt(c.viewFreezeDays ?? siteFreezeDays, 1, 365),
    retainer_cents: c.retainerEnabled && Number(c.retainerAmount) > 0 ? clampInt(cents(c.retainerAmount), 0, MAX_CENTS) : null,
    flat_rate_cents: c.flatRateEnabled && Number(c.flatRateAmount) > 0 ? clampInt(cents(c.flatRateAmount), 0, MAX_CENTS) : null,
    daily_target_posts: clampInt(c.dailyVideos ?? 1, 0, 30) ?? 1,
    pay_cycle: oneOf(c.payCycleFrequency, PAY_CYCLES, null),
    pay_cycle_anchor_day: clampInt(c.payCycleAnchorDay, 1, 31),
    pay_cycle_anchor_weekday: clampInt(c.payCycleAnchorWeekday, 0, 6),
    pay_cycle_anchor_days: days,
    payout_rule: {},
    source: "ripple",
    source_id: c.id,
  };
}

function bump(parts: Record<string, number>, part: string, n = 1) {
  if (n > 0) parts[part] = (parts[part] ?? 0) + n;
}

export function buildPlan(exp: RippleExport, zone: string): Plan {
  const warnings: string[] = [];
  const site = exp.site?.viewFreezeDays ?? null;
  const ledger: Plan["ledger"] = {};
  const tally = (name: string, exported: number) => (ledger[name] = { exported, parts: {} }).parts;

  const masterLogo = new Map<string, string | null>([
    ...exp.foreign_masters.map((m) => [m.id, m.logo] as const),
    ...exp.campaigns.map((c) => [c.id, c.logo] as const),
  ]);
  const brandLogo = new Map(exp.brands.map((b) => [b.id, b.brandLogo]));
  const logos = new Map<string, string>();
  const logoPath = (c: RippleCampaign) => {
    const src = safeLogo(
      c.logo ?? (c.masterCampaignId ? masterLogo.get(c.masterCampaignId) : null) ?? (c.brandId ? brandLogo.get(c.brandId) : null),
    );
    if (!src) return null;
    const path = logoObjectPath(src);
    logos.set(path, src);
    return path;
  };
  const brandName = (c: RippleCampaign) => c.name.trim().slice(0, 200) || "Untitled";

  // Campaigns: every master is a template (his, a brand's or another admin's: the catalog the
  // owner adds from). Of the rest, his are deals; another Ripple user's are skipped with a warning.
  const cParts = tally("campaigns", exp.campaigns.length);
  const templates: PlanItem[] = [];
  const deals: PlanItem[] = [];
  const flatCliff = (row: Row) => {
    let prev = Number(row.cpm_rate ?? 0) || 0;
    for (const t of row.cpm_tiers as { ratePerUnit: number }[]) {
      if (t.ratePerUnit < prev) return true;
      prev = t.ratePerUnit;
    }
    return false;
  };
  const warnCliff = (c: RippleCampaign, row: Row) => {
    if (row.cpm_tier_mode === "COMBINED_FLAT" && flatCliff(row)) {
      warnings.push(`campaign ${c.id} (${row.brand_name}): "Combined: flat" tiers step down; imported as is, Hydra will ask to fix the tiers on its next edit`);
    }
  };
  for (const c of exp.campaigns) {
    if (!c.isMaster && c.userId !== exp.owner.id) {
      warnings.push(`campaign ${c.id} (${brandName(c)}) belongs to another Ripple user; not imported`);
      bump(cParts, "skipped: another Ripple user's deal");
      continue;
    }
    if (c.isMaster) {
      templates.push({
        key: c.id,
        rippleIds: [c.id],
        row: { ...payStructure(c, site), brand_name: brandName(c), logo_path: logoPath(c), archived: c.archivedAt !== null },
      });
      warnCliff(c, templates[templates.length - 1].row);
      bump(cParts, "deal_templates");
      continue;
    }
    const start = dayKey(utc(c.createdAt), zone);
    const archived = c.archivedAt ? dayKey(utc(c.archivedAt), zone) : null;
    deals.push({
      key: c.id,
      rippleIds: [c.id],
      row: {
        ...payStructure(c, site),
        brand_name: brandName(c),
        logo_path: logoPath(c),
        status: archived ? "ended" : "active",
        start_date: start,
        end_date: archived && archived < start ? start : archived,
      },
    });
    warnCliff(c, deals[deals.length - 1].row);
    bump(cParts, "deals");
  }
  const dealByRippleId = new Map(deals.map((d) => [d.key, d]));

  // Accounts: a label per deal, platform and handle. Several Ripple accounts can share one.
  const aParts = tally("accounts", exp.accounts.length);
  const accounts = new Map<string, PlanItem & { dealKey: string }>();
  const accountKeyByRippleId = new Map<string, string>();
  const usernameByRippleId = new Map<string, string>();
  for (const a of exp.accounts) {
    if (!a.campaignId || !dealByRippleId.has(a.campaignId)) {
      bump(aParts, "skipped: not on an imported deal");
      continue;
    }
    if (!PLATFORMS.includes(a.platform)) {
      bump(aParts, "skipped: platform Hydra does not track");
      continue;
    }
    const handle = (normalizeHandle(a.username) || a.platformUserId.toLowerCase()).slice(0, 100);
    const key = `${a.campaignId}|${a.platform}|${handle}`;
    const hit = accounts.get(key);
    if (hit) hit.rippleIds.push(a.id);
    else accounts.set(key, { key, dealKey: a.campaignId, rippleIds: [a.id], row: { platform: a.platform, handle } });
    accountKeyByRippleId.set(a.id, key);
    usernameByRippleId.set(a.id, a.username);
    bump(aParts, "deal_accounts (by Ripple account)");
  }

  // Snapshots by post, oldest first.
  const snapsByPost = new Map<string, RippleSnapshot[]>();
  for (const s of exp.snapshots) {
    const list = snapsByPost.get(s.platformPostId);
    if (list) list.push(s);
    else snapsByPost.set(s.platformPostId, [s]);
  }
  for (const list of snapsByPost.values()) list.sort((a, b) => utc(a.capturedAt).getTime() - utc(b.capturedAt).getTime());
  const groupByPost = new Map(exp.unified_links.map((l) => [l.platformPostId, l.unifiedVideoId]));

  // Posts. Hydra keys a post by its URL; when two Ripple posts share one, keep the one on an
  // active deal, then the one with more readings, then the newer row.
  const pParts = tally("posts", exp.posts.length);
  const candidates: { post: RipplePost; url: string; accountKey: string; dealKey: string; synthetic: boolean }[] = [];
  for (const p of exp.posts) {
    const accountKey = accountKeyByRippleId.get(p.connectedAccountId);
    if (!accountKey) {
      bump(pParts, "skipped: account not on an imported deal");
      continue;
    }
    const built = rippleVideoUrl(p, usernameByRippleId.get(p.connectedAccountId) ?? "");
    const url = built ? normalizePostUrl(built) : null;
    candidates.push({
      post: p,
      // ponytail: a post Ripple could not link keeps a unique placeholder URL on the reserved
      // .invalid domain, so its pay history still imports. It opens nothing.
      url: url ?? `https://ripple.invalid/${p.platform.toLowerCase()}/${encodeURIComponent(p.platformPostId || p.id)}`,
      accountKey,
      dealKey: accounts.get(accountKey)!.dealKey,
      synthetic: !url,
    });
  }
  const rank = (c: (typeof candidates)[number]) =>
    [dealByRippleId.get(c.dealKey)!.row.status === "active" ? 1 : 0, snapsByPost.get(c.post.id)?.length ?? 0, utc(c.post.createdAt).getTime()];
  const byUrl = new Map<string, (typeof candidates)[number]>();
  for (const c of candidates) {
    const held = byUrl.get(c.url);
    if (!held) {
      byUrl.set(c.url, c);
      continue;
    }
    const [a, b] = [rank(c), rank(held)];
    const better = a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || (c.post.id > held.post.id ? 1 : -1);
    if (better > 0) byUrl.set(c.url, c);
    bump(pParts, "skipped: same URL as another Ripple post");
  }

  const posts: PostItem[] = [];
  const snapshots: SnapshotItem[] = [];
  const sParts = tally("snapshots", exp.snapshots.length);
  const importedPostIds = new Set<string>();
  for (const c of byUrl.values()) {
    const p = c.post;
    importedPostIds.add(p.id);
    bump(pParts, c.synthetic ? "posts (placeholder URL)" : "posts");
    posts.push({
      key: p.id,
      rippleIds: [p.id],
      dealKey: c.dealKey,
      accountKey: c.accountKey,
      row: {
        platform: p.platform,
        url: c.url,
        title: p.caption ? Array.from(p.caption.trim()).slice(0, 500).join("") || null : null,
        posted_at: utc(p.postedAt).toISOString(),
        video_group_id: groupByPost.get(p.id) ?? null,
        // "Mark irrelevant" is Ripple's stronger exclude: it also pays $0.
        exclude_from_pay: p.excludeFromEarnings || p.markedIrrelevantAt !== null,
        manual_override_cents: cents(p.manualEarningsOverride),
        base_pay_cents_snap: cents(p.paymentPerVideoSnapshot),
        base_min_views_snap: p.basePayMinViewsSnapshot,
        view_bonuses_snap: p.viewBonusesSnapshot == null ? null : bonusesToCents(p.viewBonusesSnapshot),
        view_bonus_mode_snap: p.viewBonusModeSnapshot,
        cpm_rate_snap: rate(p.cpmRateSnapshot),
        cpm_view_unit_snap: p.cpmViewUnitSnapshot,
        cpm_cap_views_snap: p.cpmCapViewsSnapshot,
        cpm_min_views_snap: p.cpmMinViewsSnapshot,
        cpm_tiers_snap: p.cpmTiersSnapshot == null ? null : cpmTiers(p.cpmTiersSnapshot),
        cpm_mode_snap: p.cpmModeSnapshot,
        cpm_tier_mode_snap: p.tierEvaluationModeSnapshot,
        source: "ripple",
        source_id: p.id,
      },
    });

    // Readings: the last one of each owner-zone day.
    const byDay = new Map<string, SnapshotItem>();
    const readings = snapsByPost.get(p.id) ?? [];
    for (const s of readings) {
      const at = utc(s.capturedAt);
      const day = dayKey(at, zone);
      const prev = byDay.get(day);
      byDay.set(day, {
        key: `${p.id}|${day}`,
        postKey: p.id,
        synthetic: false,
        rippleIds: [...(prev?.rippleIds ?? []), s.id],
        row: { captured_day: day, captured_at: at.toISOString(), views: s.views, likes: s.likes, comments: s.comments, held: false, source: "ripple" },
      });
    }

    // Ripple pays on the post's view count, which stops at its freeze day. Hydra pays the last
    // reading captured inside the freeze window. When Ripple's readings start after the window
    // (posts synced late) or miss the final count, add that count as a reading at the end of the
    // window (or at its sync time, if earlier), so Hydra pays what Ripple paid.
    const freezeDays = Number(dealByRippleId.get(c.dealKey)!.row.view_freeze_days ?? DEFAULT_FREEZE_DAYS);
    const posted = utc(p.postedAt).getTime();
    const cutoff = posted + freezeDays * DAY_MS;
    const inWindow = readings.filter((s) => utc(s.capturedAt).getTime() <= cutoff);
    const last = inWindow[inWindow.length - 1];
    if (last ? last.views !== p.viewCount : p.viewCount > 0) {
      const synced = utc(p.viewsSyncedAt ?? p.updatedAt).getTime();
      let t = Math.max(posted, Math.min(synced, cutoff));
      if (last && t <= utc(last.capturedAt).getTime()) t = cutoff;
      const at = new Date(t);
      const day = dayKey(at, zone);
      const prev = byDay.get(day);
      byDay.set(day, {
        key: `${p.id}|${day}`,
        postKey: p.id,
        synthetic: true,
        rippleIds: [...(prev?.rippleIds ?? []), `viewcount:${p.id}`],
        row: { captured_day: day, captured_at: at.toISOString(), views: p.viewCount, likes: p.likeCount, comments: p.commentCount, held: false, source: "ripple" },
      });
    }
    for (const s of byDay.values()) {
      snapshots.push(s);
      const real = s.rippleIds.filter((id) => !id.startsWith("viewcount:")).length;
      if (s.synthetic) bump(sParts, "replaced by the view-count reading on its day", real);
      else {
        bump(sParts, "post_view_snapshots (last reading of its day)");
        bump(sParts, "folded into a later reading the same day", real - 1);
      }
    }
  }
  bump(sParts, "skipped: post not imported", exp.snapshots.filter((s) => !importedPostIds.has(s.platformPostId)).length);

  return { zone, templates, deals, accounts: [...accounts.values()], posts, snapshots, logos, ledger, warnings };
}

/** Every exported row must land in exactly one part. Returns the mismatches. */
export function checkLedger(plan: Plan): string[] {
  return Object.entries(plan.ledger).flatMap(([name, { exported, parts }]) => {
    const used = Object.values(parts).reduce((n, v) => n + v, 0);
    return used === exported ? [] : [`${name}: exported ${exported}, accounted for ${used}`];
  });
}

export function planCounts(plan: Plan): Record<string, number> {
  const ripplePerSnap = plan.snapshots.reduce((n, s) => n + s.rippleIds.length, 0);
  return {
    deal_templates: plan.templates.length,
    deals: plan.deals.length,
    deal_accounts: plan.accounts.length,
    posts: plan.posts.length,
    post_view_snapshots: plan.snapshots.length,
    "post_view_snapshots from Ripple view count": plan.snapshots.filter((s) => s.synthetic).length,
    day_targets: 0, // Ripple has no per-day targets; dailyVideos becomes daily_target_posts.
    "logos (storage objects)": plan.logos.size,
    import_ripple_map:
      plan.templates.length + plan.deals.length + plan.accounts.reduce((n, a) => n + a.rippleIds.length, 0) + plan.posts.length + ripplePerSnap,
  };
}

// ─── Write: SQL that the database owner runs ─────────────────────────────────

/** One Ripple item for private.ripple_import_apply (0011): its Ripple ids and the Hydra row. */
export interface ImportItem {
  ripple_ids: string[];
  row: Row;
}
export interface DealPayload extends ImportItem {
  accounts: (ImportItem & { key: string })[];
  posts: (ImportItem & { account: string | null; snapshots: ImportItem[] })[];
}
export interface Payload {
  templates: ImportItem[];
  deals: DealPayload[];
}
/** Per entity, per status (inserted, skipped_existing, skipped_deleted, skipped_conflict, skipped_url_collision). */
export type Counts = Record<string, Record<string, number>>;
/** What one call of private.ripple_import_apply returns. */
export interface ApplyResult {
  counts: Counts;
  /** Ripple post ids skipped for a URL collision that carried an exclude flag or manual override. */
  url_collision_flagged: string[];
}

/**
 * Text Postgres jsonb cannot hold: NUL is dropped and a lone UTF-16 surrogate becomes U+FFFD.
 * Applied to every string in a payload, so one odd caption cannot fail a file on every rerun.
 */
export function cleanText(v: string): string {
  return v.replaceAll("\u0000", "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

function cleanDeep<T>(v: T): T {
  if (typeof v === "string") return cleanText(v) as T;
  if (Array.isArray(v)) return v.map(cleanDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanDeep(x)])) as T;
  return v;
}

/** Default payload size per SQL file. The hosted `db query` limit is not documented; 1 MB is far under any HTTP body limit. */
export const DEFAULT_MAX_BYTES = 1_000_000;

const item = (i: PlanItem): ImportItem => cleanDeep({ ripple_ids: i.rippleIds, row: i.row });

/**
 * The import as function payloads. Each deal travels whole (its accounts, posts and their view
 * snapshots) in one payload, so every call is safe on its own and a partial run can be rerun.
 * Templates go in the first payload. A new payload starts when the next deal would push the JSON
 * past maxBytes (a single larger deal still gets one payload of its own). Rows whose logo is not
 * in `logoOk` keep no logo.
 */
export function buildPayloads(plan: Plan, maxBytes = DEFAULT_MAX_BYTES, logoOk: (path: string) => boolean = () => true): Payload[] {
  const withLogo = (i: PlanItem): ImportItem =>
    item(i.row.logo_path && !logoOk(i.row.logo_path as string) ? { ...i, row: { ...i.row, logo_path: null } } : i);
  const snapsByPost = new Map<string, ImportItem[]>();
  for (const s of plan.snapshots) snapsByPost.set(s.postKey, [...(snapsByPost.get(s.postKey) ?? []), item(s)]);
  const deals = new Map<string, DealPayload>(plan.deals.map((d) => [d.key, { ...withLogo(d), accounts: [], posts: [] }]));
  for (const a of plan.accounts) deals.get(a.dealKey)!.accounts.push({ key: cleanText(a.key), ...item(a) });
  for (const p of plan.posts) {
    deals.get(p.dealKey)!.posts.push({ ...item(p), account: cleanText(p.accountKey), snapshots: snapsByPost.get(p.key) ?? [] });
  }

  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  const out: Payload[] = [{ templates: plan.templates.map(withLogo), deals: [] }];
  let size = bytes(out[0]);
  for (const d of deals.values()) {
    const n = bytes(d) + 1;
    const current = out[out.length - 1];
    if (size + n > maxBytes && (current.deals.length > 0 || current.templates.length > 0)) {
      out.push({ templates: [], deals: [d] });
      size = bytes(out[out.length - 1]);
    } else {
      current.deals.push(d);
      size += n;
    }
  }
  return out;
}

/** One statement that runs one payload in one transaction. The dollar-quote tag never occurs in the JSON. */
export function payloadSql(p: Payload): string {
  const json = JSON.stringify(p);
  let tag = "ripple";
  while (json.includes(`$${tag}$`)) tag += "_";
  return `select private.ripple_import_apply($${tag}$${json}$${tag}$::jsonb);\n`;
}

export function addCounts(a: Counts, b: Counts): Counts {
  const out: Counts = structuredClone(a);
  for (const [entity, c] of Object.entries(b)) {
    const t = (out[entity] ??= {});
    for (const [status, n] of Object.entries(c)) t[status] = (t[status] ?? 0) + n;
  }
  return out;
}

/** The image type from the first bytes; null for anything the bucket does not take. */
export function sniffImage(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/**
 * Each logo's bytes and type, from the cache in <exportDir>/logos or downloaded (and cached).
 * A logo that cannot be fetched or is not a png, jpeg, webp or gif is left out.
 */
export async function loadLogos(plan: Plan, exportDir: string, origin: string): Promise<Map<string, { bytes: Uint8Array; type: string }>> {
  const out = new Map<string, { bytes: Uint8Array; type: string }>();
  for (const [path, source] of plan.logos) {
    const cache = join(exportDir, "logos", source.replace(/^https?:\/\//, ""));
    let bytes: Uint8Array | null = existsSync(cache) ? new Uint8Array(readFileSync(cache)) : null;
    if (!bytes) {
      const url = /^https?:\/\//.test(source) ? source : `${origin}/${source}`;
      const res = await fetch(url).catch(() => null);
      if (res?.ok) {
        bytes = new Uint8Array(await res.arrayBuffer());
        mkdirSync(dirname(cache), { recursive: true });
        writeFileSync(cache, bytes);
      }
    }
    const type = bytes && sniffImage(bytes);
    if (bytes && type) out.set(path, { bytes, type });
    else console.warn(`logo ${source}: ${bytes ? "not a png, jpeg, webp or gif" : "download failed"}; the row keeps no logo`);
  }
  return out;
}

/** Upload logos to the private deal-logos bucket (service key: Storage only). Returns the paths that failed. */
export async function uploadLogos(db: SupabaseClient, logos: Map<string, { bytes: Uint8Array; type: string }>): Promise<Set<string>> {
  const failed = new Set<string>();
  for (const [path, { bytes, type }] of logos) {
    const { error } = await db.storage.from("deal-logos").upload(path, bytes, { contentType: type, upsert: true });
    if (error) {
      console.warn(`logo ${path}: upload failed: ${error.message}; the row keeps no logo`);
      failed.add(path);
    }
  }
  return failed;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const SUPABASE_CLI = ["--yes", "supabase@3.2.0"];
const HOSTED_REF = "your-project-ref";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** psql against a database URL; ON_ERROR_STOP makes a failed statement a failed run. */
function psql(dbUrl: string, args: string[]): string {
  return execFileSync("psql", [dbUrl, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
}

/** Run one SQL file; returns what the function returned. */
function runFile(file: string, dbUrl: string | undefined): ApplyResult {
  if (dbUrl) return JSON.parse(psql(dbUrl, ["-f", file]).trim()) as ApplyResult;
  const out = execFileSync("npx", [...SUPABASE_CLI, "db", "query", "-f", file], { encoding: "utf8", maxBuffer: 64 << 20 });
  const start = out.search(/^\{/m);
  const rows = (JSON.parse(out.slice(start)) as { rows: { ripple_import_apply: ApplyResult }[] }).rows;
  return rows[0].ripple_import_apply;
}

const USAGE =
  "Usage: node scripts/import-ripple/import-ripple.mts <exportDir> [--zone <IANA>]\n" +
  "         [--write --out <dir> [--db-url <postgres url> | --local] [--max-bytes <n>] [--env <file>]]";

async function main() {
  const exportDir = process.argv[2];
  if (!exportDir || exportDir.startsWith("--") || !existsSync(join(exportDir, "campaigns.json"))) {
    console.error(USAGE);
    process.exit(2);
  }
  const doWrite = process.argv.includes("--write");
  const dbUrl = arg("--db-url");
  const local = process.argv.includes("--local");
  const envFile = arg("--env");
  if (envFile) process.loadEnvFile(envFile);
  const maxBytes = Number(arg("--max-bytes") ?? DEFAULT_MAX_BYTES);
  if (!Number.isInteger(maxBytes) || maxBytes < 10_000) {
    console.error("--max-bytes must be a whole number of at least 10000");
    process.exit(2);
  }

  let zone = arg("--zone");
  if (zone && !isZone(zone)) {
    console.error(`--zone ${zone} is not an IANA time zone`);
    process.exit(2);
  }
  if (!zone && dbUrl) zone = psql(dbUrl, ["-c", "select time_zone from public.settings limit 1"]).trim() || undefined;
  if (!isZone(zone)) {
    if (doWrite) {
      console.error("--write needs the owner's zone: pass --zone <IANA> (or --db-url to a database whose settings hold it)");
      process.exit(2);
    }
    zone = "UTC";
  }

  const exp = readExport(exportDir);
  const plan = buildPlan(exp, zone);
  console.log(`Ripple export of ${exp.owner.email} (${exp.owner.id}); day keys in ${zone}`);
  for (const [name, { exported, parts }] of Object.entries(plan.ledger)) {
    console.log(`  export ${name}: ${exported}`);
    for (const [part, n] of Object.entries(parts)) console.log(`    ${part}: ${n}`);
  }
  for (const w of plan.warnings) console.warn(`  WARNING ${w}`);
  const problems = checkLedger(plan);
  if (problems.length) {
    for (const p of problems) console.error(`  MISMATCH ${p}`);
    process.exit(1);
  }
  console.log(`${doWrite ? "Writing" : "Dry run (nothing written)"}: rows per Hydra table`);
  for (const [table, n] of Object.entries(planCounts(plan))) console.log(`  ${table}: ${n}`);
  if (!doWrite) return;

  // Logos: only those whose bytes are a raster image keep their path. They go to Storage with the
  // service key when one is given (Storage only; it cannot touch posts).
  const logos = await loadLogos(plan, exportDir, process.env.RIPPLE_MEDIA_ORIGIN?.trim() || "https://media.rippleugc.com");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (url && key) {
    const failed = await uploadLogos(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }), logos);
    for (const p of failed) logos.delete(p);
    console.log(`Logos uploaded to ${url}: ${logos.size}, failed: ${plan.logos.size - logos.size}`);
  } else {
    console.warn(`Logos NOT uploaded (no NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY); ${logos.size} rows will name objects in deal-logos. Rerun with --env <file> to upload them.`);
  }

  const outDir = arg("--out") ?? join(tmpdir(), `ripple-import-${Date.now()}`);
  mkdirSync(outDir, { recursive: true });
  const payloads = buildPayloads(plan, maxBytes, (p) => logos.has(p));
  const files = payloads.map((p, i) => {
    const file = join(outDir, `ripple-import-${String(i + 1).padStart(3, "0")}.sql`);
    writeFileSync(file, payloadSql(p));
    return file;
  });
  const sizes = files.map((f) => readFileSync(f).length);
  console.log(`SQL: ${files.length} file(s) in ${outDir}, ${sizes.reduce((a, b) => a + b, 0)} bytes, largest ${Math.max(...sizes)} bytes`);

  if (dbUrl || local) {
    let total: Counts = {};
    const flagged: string[] = [];
    for (const f of files) {
      const r = runFile(f, dbUrl);
      console.log(`  ${f}: ${JSON.stringify(r.counts)}`);
      total = addCounts(total, r.counts);
      flagged.push(...r.url_collision_flagged);
    }
    console.log("Totals (inserted / skipped_existing / skipped_deleted / skipped_conflict / skipped_url_collision):");
    for (const [entity, c] of Object.entries(total)) {
      console.log(`  ${entity}: ${c.inserted} / ${c.skipped_existing} / ${c.skipped_deleted} / ${c.skipped_conflict} / ${c.skipped_url_collision}`);
    }
    if (flagged.length) {
      console.warn(`WARNING ${flagged.length} Ripple post(s) skipped because Hydra already tracks their URL carried an exclude flag or manual override that was NOT applied; set them by hand:`);
      for (const id of flagged) console.warn(`  ${id}`);
    }
  }
  console.log("Hosted (run by the orchestrator, in order; each file is one transaction and safe to rerun):");
  for (const f of files) console.log(`  npx ${SUPABASE_CLI.join(" ")} db query --remote=${HOSTED_REF} -f ${f}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
