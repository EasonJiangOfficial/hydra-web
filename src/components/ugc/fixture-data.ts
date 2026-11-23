/**
 * Realistic UGC data for /dev/ugc and the tests: four deals, seven weeks of posts with daily view readings,
 * matched and open deposits, a day off, a held reading, an excluded video, and Ripple templates.
 * Deterministic: the clock is fixed at Saturday, November 21, 2026 (Toronto) and the "randomness" is a seeded generator.
 */
import { addDays, dayKeysBetween, zonedDayStart } from "@/lib/ugc/days";
import type { EngagementRow, WithEngagement } from "@/lib/ugc/analytics";
import { DEAL_DEFAULTS, dealInputToRow, type DealDbRow, type DealInput } from "@/lib/ugc/schemas";
import { freezeCutoff } from "@/lib/ugc/view-freeze";
import { matchDealOf, owedCycles } from "@/lib/ugc/payout-match";
import { buildModel } from "./model";
import type { AccountRaw, PostRaw, PostViewRaw, SnapshotRaw, TemplateRaw, UgcRaw } from "./types";

export const FIXTURE_NOW = "2026-11-21T15:00:00.000Z";
export const FIXTURE_ZONE = "America/Toronto";
export const FIXTURE_TODAY = "2026-11-21";

/** Fixture ids: valid v4-shaped uuids, readable in tests. */
export const fid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const DEAL_WORDWISE = fid(101);
export const DEAL_BRIGHTLEAF = fid(102);
export const DEAL_CANVASLY = fid(103);
export const DEAL_STUDYFETCH = fid(104);

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function deal(
  id: string,
  status: DealDbRow["status"],
  input: Partial<DealInput> & Pick<DealInput, "brandName" | "startDate">,
): DealDbRow {
  const full: DealInput = { ...DEAL_DEFAULTS, ...input };
  return {
    ...dealInputToRow(full),
    id,
    entity_id: fid(1),
    status,
    source: "ripple",
    source_id: `ripple-${id.slice(-3)}`,
    created_at: `${input.startDate}T12:00:00.000Z`,
    updated_at: `${input.startDate}T12:00:00.000Z`,
  } as DealDbRow;
}

/** A monochrome square with initials: stands in for a logo in the private bucket (data URIs pass the CSP). */
function logoDataUri(initials: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
    `<rect width="96" height="96" rx="12" fill="#1d1d1f"/>` +
    `<text x="48" y="58" font-family="Helvetica,Arial,sans-serif" font-size="34" font-weight="500" text-anchor="middle" fill="#fff">${initials}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const TITLES: Record<string, string[]> = {
  [DEAL_WORDWISE]: [
    "3 apps for when you are bored",
    "Worst classes ranked",
    "Watch this before finals",
    "GTA 6 apps",
    "Group project survival kit",
    "The essay trick nobody tells you",
    "Study with me, 3 AM edition",
  ],
  [DEAL_BRIGHTLEAF]: [
    "After school procrastinator",
    "Morning peak routine",
    "Homework in 20 minutes",
    "Parent hack for finals week",
    "Study group, but make it easy",
  ],
  [DEAL_CANVASLY]: ["Roblox walkthrough", "Turn your drawings into games", "I made a trailer with AI"],
  [DEAL_STUDYFETCH]: ["Flashcards in one tap", "Quiz me on this"],
};

const TIERS_WORDWISE = [
  { views: 100_000, bonusCents: 10_000 },
  { views: 500_000, bonusCents: 40_000 },
  { views: 1_000_000, bonusCents: 100_000 },
];

export function fixtureDeals(): DealDbRow[] {
  return [
    deal(DEAL_WORDWISE, "active", {
      brandName: "Wordwise",
      logoPath: "ripple/wordwise.png",
      startDate: "2026-10-01",
      basePayCents: 2500,
      viewBonuses: TIERS_WORDWISE,
      viewBonusMode: "ADD",
      dailyTargetPosts: 2,
      payCycle: "MONTHLY",
      payCycleAnchorDay: 15,
      payoutRule: { payerContains: "WORDWISE", minCents: 10_000 },
    }),
    deal(DEAL_BRIGHTLEAF, "active", {
      brandName: "Brightleaf",
      startDate: "2026-10-15",
      basePayCents: 4000,
      cpmRate: 2,
      cpmViewUnit: 1000,
      dailyTargetPosts: 1,
      payCycle: "BIWEEKLY",
      payCycleAnchorWeekday: 5,
      payoutRule: { payerContains: "BRIGHTLEAF" },
    }),
    deal(DEAL_CANVASLY, "paused", {
      brandName: "Canvasly",
      startDate: "2026-10-20",
      basePayCents: 3500,
      dailyTargetPosts: 1,
      payoutRule: { payerContains: "CANVASLY" },
    }),
    deal(DEAL_STUDYFETCH, "ended", {
      brandName: "Studyfetch",
      startDate: "2026-09-01",
      endDate: "2026-10-31",
      basePayCents: 2000,
      dailyTargetPosts: 1,
      payoutRule: { payerContains: "STUDYFETCH" },
    }),
  ];
}

function template(id: string, source: string, input: Partial<DealInput> & { brandName: string }): TemplateRaw {
  const row = deal(id, "active", { ...input, startDate: "2026-01-01" });
  const { entity_id: _e, status: _s, start_date: _a, end_date: _b, ...rest } = row;
  void [_e, _s, _a, _b];
  return { ...rest, source: "ripple", source_id: source, archived: false };
}

export function fixtureTemplates(): TemplateRaw[] {
  return [
    template(fid(901), "ripple-cluely", {
      brandName: "Cluely",
      logoPath: "ripple/cluely.png",
      basePayCents: 3000,
      cpmRate: 1.5,
      cpmViewUnit: 1000,
      cpmCapViews: 500_000,
      dailyTargetPosts: 1,
      payoutRule: { payerContains: "CLUELY" },
    }),
    template(fid(902), "ripple-wordwise", {
      brandName: "Wordwise",
      logoPath: "ripple/wordwise.png",
      basePayCents: 2500,
      viewBonuses: TIERS_WORDWISE,
      viewBonusMode: "ADD",
      dailyTargetPosts: 2,
    }),
    template(fid(903), "ripple-notion", {
      brandName: "Notion Campus",
      basePayCents: 5000,
      baseMinViews: 5000,
      dailyTargetPosts: 1,
    }),
  ];
}

/** Payable and latest views per post from its readings (what the `ugc_post_views` view returns). */
export function deriveViews(
  posts: readonly PostRaw[],
  deals: readonly Pick<DealDbRow, "id" | "view_freeze_days">[],
  snapshots: readonly SnapshotRaw[],
): PostViewRaw[] {
  const freeze = new Map(deals.map((d) => [d.id, d.view_freeze_days]));
  const byPost = new Map<string, SnapshotRaw[]>();
  for (const s of snapshots) byPost.set(s.post_id, [...(byPost.get(s.post_id) ?? []), s]);
  return posts.map((p) => {
    const snaps = [...(byPost.get(p.id) ?? [])].sort(
      (a, b) => b.captured_day.localeCompare(a.captured_day) || b.captured_at.localeCompare(a.captured_at),
    );
    const cutoff = freezeCutoff(new Date(p.posted_at), freeze.get(p.deal_id) ?? null).getTime();
    const payable = snaps.find((s) => !s.held && Date.parse(s.captured_at) <= cutoff);
    const latest = snaps[0];
    return {
      post_id: p.id,
      payable_views: payable ? payable.views : null,
      latest_views: latest ? latest.views : null,
      last_captured_at: latest?.captured_at ?? null,
      last_captured_day: latest?.captured_day ?? null,
      latest_held: latest?.held ?? false,
    };
  });
}

/** How many posts a deal gets on a day: mostly the target, sometimes short, sometimes a day missed. */
function countFor(rand: () => number, target: number): number {
  const r = rand();
  if (r < 0.1) return 0;
  if (r < 0.3) return Math.max(0, target - 1);
  if (r < 0.9) return target;
  return target + 1;
}

/**
 * Likes and comments from each post's latest trusted reading: 5 to 7% likes and 0.4% comments of views.
 * YouTube posts carry none (Grokbot reads only views there), so the analytics show unread engagement.
 */
export function fixtureEngagement(posts: readonly PostRaw[], snapshots: readonly SnapshotRaw[]): EngagementRow[] {
  const latest = new Map<string, SnapshotRaw>();
  for (const s of snapshots) {
    const prev = latest.get(s.post_id);
    if (!s.held && (!prev || s.captured_day > prev.captured_day)) latest.set(s.post_id, s);
  }
  return posts.flatMap((p, i) => {
    const s = latest.get(p.id);
    if (!s || p.platform === "YOUTUBE") return [];
    return [{ post_id: p.id, likes: Math.round(s.views * (0.05 + (i % 5) * 0.005)), comments: Math.round(s.views * 0.004) }];
  });
}

export function fixtureRaw(): UgcRaw & WithEngagement {
  const zone = FIXTURE_ZONE;
  const today = FIXTURE_TODAY;
  const deals = fixtureDeals();
  const dealById = new Map(deals.map((d) => [d.id, d]));
  const accounts: AccountRaw[] = [
    { id: fid(201), deal_id: DEAL_WORDWISE, platform: "TIKTOK", handle: "alex.ugc" },
    { id: fid(202), deal_id: DEAL_WORDWISE, platform: "INSTAGRAM", handle: "alex.tech" },
    { id: fid(203), deal_id: DEAL_BRIGHTLEAF, platform: "INSTAGRAM", handle: "alex.tech" },
    { id: fid(204), deal_id: DEAL_BRIGHTLEAF, platform: "YOUTUBE", handle: "alex.tech" },
    { id: fid(205), deal_id: DEAL_CANVASLY, platform: "TIKTOK", handle: "alex.ugc" },
    { id: fid(206), deal_id: DEAL_STUDYFETCH, platform: "TIKTOK", handle: "alex.ugc" },
  ];

  const posts: PostRaw[] = [];
  const snapshots: SnapshotRaw[] = [];
  const rand = seeded(2026);
  let n = 0;
  const plan: [string, string, string][] = [
    [DEAL_WORDWISE, "2026-10-01", today],
    [DEAL_BRIGHTLEAF, "2026-10-15", today],
    [DEAL_CANVASLY, "2026-10-20", "2026-11-09"],
    [DEAL_STUDYFETCH, "2026-09-25", "2026-10-31"],
  ];
  for (const [dealId, from, to] of plan) {
    const d = dealById.get(dealId)!;
    const accts = accounts.filter((a) => a.deal_id === dealId);
    const titles = TITLES[dealId];
    for (const day of dayKeysBetween(from, to)) {
      const count = day === "2026-11-11" && dealId === DEAL_WORDWISE ? 0 : countFor(rand, d.daily_target_posts);
      for (let k = 0; k < count; k++) {
        n++;
        const id = fid(1000 + n);
        const acct = accts[(n + k) % accts.length];
        const postedAt = new Date(zonedDayStart(day, zone).getTime() + (13 + k * 3) * 3_600_000).toISOString();
        const title = `${titles[n % titles.length]}${n > titles.length ? ` #${Math.ceil(n / titles.length)}` : ""}`;
        posts.push({
          id,
          deal_id: dealId,
          account_id: acct.id,
          url: `https://${acct.platform === "TIKTOK" ? "tiktok.com/@" + acct.handle + "/video" : acct.platform === "INSTAGRAM" ? "instagram.com/reel" : "youtube.com/shorts"}/${7_300_000_000 + n * 97}`,
          platform: acct.platform,
          title,
          posted_at: postedAt,
          video_group_id: null,
          exclude_from_pay: false,
          manual_override_cents: null,
          base_pay_cents_snap: d.base_pay_cents === null ? null : Number(d.base_pay_cents),
          base_min_views_snap: d.base_min_views,
          view_bonuses_snap: d.view_bonuses,
          view_bonus_mode_snap: d.view_bonus_mode,
          cpm_rate_snap: d.cpm_rate,
          cpm_view_unit_snap: d.cpm_view_unit,
          cpm_cap_views_snap: d.cpm_cap_views,
          cpm_min_views_snap: d.cpm_min_views,
          cpm_tiers_snap: d.cpm_tiers,
          cpm_mode_snap: d.cpm_mode,
          cpm_tier_mode_snap: d.cpm_tier_mode,
        });
        // Daily readings from the posting day until today or the end of the 14-day window.
        const final = Math.round(1500 * Math.exp(rand() * 6.2));
        const freeze = d.view_freeze_days ?? 14;
        const end = addDays(day, freeze);
        const last = end < today ? end : today;
        dayKeysBetween(day, last).forEach((rd, i) => {
          snapshots.push({
            post_id: id,
            captured_day: rd,
            captured_at: new Date(zonedDayStart(rd, zone).getTime() + 20 * 3_600_000).toISOString(),
            views: Math.round(final * (1 - Math.pow(0.55, i + 1))),
            held: false,
          });
        });
      }
    }
  }

  // One video on two accounts (paid once), one excluded video, one held reading, one override price.
  const wordwise = posts.filter((p) => p.deal_id === DEAL_WORDWISE);
  const a = wordwise[wordwise.length - 4];
  const b = wordwise[wordwise.length - 3];
  a.video_group_id = "grp-boredom";
  b.video_group_id = "grp-boredom";
  b.posted_at = a.posted_at;
  posts.filter((p) => p.deal_id === DEAL_CANVASLY)[3].exclude_from_pay = true;
  const brightleaf = posts.filter((p) => p.deal_id === DEAL_BRIGHTLEAF);
  const held = brightleaf[brightleaf.length - 1];
  const heldSnap = snapshots.filter((s) => s.post_id === held.id).at(-1)!;
  heldSnap.views = 4_200_000;
  heldSnap.held = true;
  wordwise[wordwise.length - 8].manual_override_cents = 6000;

  // Video matching: an unlinked TikTok + Reels twin (same caption), and a held one (its twin is excluded).
  // Titles and platform, and the held twin moves to a day that already met its target, so no figure moves.
  const twin = wordwise.slice(-14, -8).find((p, i, all) => all[i + 1] && all[i + 1].platform !== p.platform);
  if (twin) {
    const next = wordwise[wordwise.indexOf(twin) + 1];
    next.title = `${twin.title} 😭`;
  }
  const canvasly = posts.filter((p) => p.deal_id === DEAL_CANVASLY);
  const excluded = canvasly[3];
  const heldTwin = canvasly[2];
  heldTwin.posted_at = new Date(Date.parse(excluded.posted_at) + 25 * 60_000).toISOString();
  heldTwin.platform = "INSTAGRAM";
  heldTwin.account_id = null;
  heldTwin.url = `https://instagram.com/reel/${7_400_000_004}`;
  excluded.title = "The hidden Roblox level";
  heldTwin.title = "The hidden Roblox level";

  const payments = [
    { id: fid(301), deal_id: DEAL_WORDWISE, transaction_id: fid(401), amount_cents: 128_000, paid_on: "2026-11-05", name: "WORDWISE INC PAYOUT" },
    { id: fid(302), deal_id: DEAL_BRIGHTLEAF, transaction_id: fid(402), amount_cents: 40_000, paid_on: "2026-11-12", name: "BRIGHTLEAF LLC ACH" },
    { id: fid(303), deal_id: DEAL_STUDYFETCH, transaction_id: fid(403), amount_cents: 90_000, paid_on: "2026-11-02", name: "STUDYFETCH PAYMENTS" },
  ];

  const trimmed = snapshots.filter((s) => s.captured_day >= addDays(today, -45));
  const out: UgcRaw & WithEngagement = {
    engagement: fixtureEngagement(posts, snapshots),
    nowIso: FIXTURE_NOW,
    zone,
    deals,
    accounts,
    posts,
    views: deriveViews(posts, deals, snapshots),
    snapshots: trimmed,
    payments,
    dayTargets: [
      { deal_id: DEAL_WORDWISE, day: "2026-11-11", target: 0 },
      { deal_id: DEAL_WORDWISE, day: "2026-11-15", target: 1 },
    ],
    templates: fixtureTemplates(),
    deposits: [
      { id: fid(404), name: "WORDWISE INC PAYOUT", amount_cents: 110_000, posted_on: "2026-11-19" },
      { id: fid(405), name: "STRIPE TRANSFER CANVASLY", amount_cents: 52_500, posted_on: "2026-11-17" },
      { id: fid(406), name: "ZELLE FROM FAMILY", amount_cents: 20_000, posted_on: "2026-11-14" },
    ],
    payoutRejections: [],
    payoutRules: [],
    logos: {
      "ripple/wordwise.png": logoDataUri("Ph"),
      "ripple/cluely.png": logoDataUri("Cl"),
    },
    // Grokbot read only some posts on Nov 19 and none on Nov 20.
    missedViewDays: [
      { day: "2026-11-19", needing: 9, read: 6 },
      { day: "2026-11-20", needing: 9, read: 0 },
    ],
  };
  return { ...out, deposits: [...out.deposits, ...paypalPayouts(out)] };
}

/**
 * Two PayPal transfers without a brand name that pay Brightleaf's two closed cycles (a 2.5% fee off what is
 * owed on each), landed two days after each cycle closed: what "Match payouts" suggests on the fixture.
 */
function paypalPayouts(raw: UgcRaw): UgcRaw["deposits"] {
  const view = buildModel(raw).deals.find((d) => d.deal.id === DEAL_BRIGHTLEAF)!;
  const paid = raw.payments.filter((p) => p.deal_id === DEAL_BRIGHTLEAF).map((p) => ({ amountCents: Number(p.amount_cents), paidOn: p.paid_on }));
  return owedCycles(matchDealOf(view.row, view.earnings), paid, FIXTURE_TODAY)
    .filter((c) => c.owedCents > 0)
    .slice(-2)
    .map((c, i) => ({
      id: fid(407 + i),
      name: `PAYPAL TRANSFER ${8823 + i}`,
      amount_cents: Math.round(c.owedCents * 0.975),
      posted_on: addDays(c.closesOn, 2),
    }));
}
