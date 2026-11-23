/**
 * Cross-post matcher (match.ts) on the measured shapes: Wordwise's TikTok
 * posts unlinked while their Instagram twins sit in groups, YouTube Shorts with
 * a cut title, same-day different videos, title-less posts, the owner's manual
 * links. Then the ledger proof: one video on 4 platforms pays once.
 */
import { describe, it, expect } from "vitest";
import {
  applyLinks,
  matchCrossPosts,
  matchCrossPostsDetailed,
  needsMatching,
  normalizeTitle,
  titleSimilarity,
  titleTokens,
  type MatchPost,
} from "@/lib/ugc/match";
import { planCrossPosts, formatPlan, writeSql, type PlanPost } from "@/lib/ugc/cross-post-plan";
import { dealEarnings, type DealRow, type PostRow } from "@/lib/ugc/ledger";

const H = 3600_000;
const T0 = Date.parse("2026-11-10T15:00:00Z");
const at = (hours: number) => new Date(T0 + hours * H).toISOString();

function p(id: string, platform: string, title: string | null, hours: number, over: Partial<MatchPost> = {}): MatchPost {
  return { id, platform, title, posted_at: at(hours), video_group_id: null, ...over };
}

describe("titles", () => {
  it("normalizes like Ripple plus punctuation: lowercase, no emoji, no #tags", () => {
    expect(normalizeTitle("The WORST classes 😭😭 to take!! #college #fyp")).toBe("the worst classes to take");
    expect(normalizeTitle(null)).toBe("");
  });

  it("a cut title matches when all its words are in the longer one", () => {
    const tt = titleTokens("the worst classes to take in college pt 3 #college #fyp");
    const yt = titleTokens("Worst classes in college pt 3 #shorts");
    expect(titleSimilarity(tt, yt)).toBeGreaterThan(0);
  });

  it("template captions of different videos do not match (Jaccard 0.29 < 0.5)", () => {
    expect(titleSimilarity(titleTokens("3 apps that cure boredom"), titleTokens("3 apps for school"))).toBe(0);
  });

  it("different numbers are different videos", () => {
    expect(titleSimilarity(titleTokens("worst classes pt 2"), titleTokens("worst classes pt 3"))).toBe(0);
  });
});

describe("matchCrossPosts", () => {
  it("links a TikTok post and its Instagram twin a few hours apart", () => {
    const links = matchCrossPosts([
      p("a1", "TIKTOK", "this app writes my essays for me 😭 #wordwise #school", 0),
      p("a2", "INSTAGRAM", "this app writes my essays for me #wordwise", 4),
    ]);
    expect(links).toEqual([
      { postId: "a1", groupId: "auto-a1" },
      { postId: "a2", groupId: "auto-a1" },
    ]);
  });

  it("an unlinked TikTok post joins the Instagram group that lacks TikTok (Wordwise's shape)", () => {
    const links = matchCrossPosts([
      p("ig", "INSTAGRAM", "worst classes in college pt 3", 0, { video_group_id: "uv-1" }),
      p("yt", "YOUTUBE", "Worst classes in college pt 3 #shorts", 1, { video_group_id: "uv-1" }),
      p("tt", "TIKTOK", "the worst classes to take in college pt 3 #college", 3),
    ]);
    expect(links).toEqual([{ postId: "tt", groupId: "uv-1" }]);
  });

  it("a YouTube Short with a shorter title joins its TikTok + Instagram pair", () => {
    const links = matchCrossPosts([
      p("tt", "TIKTOK", "POV: you found the app that does your homework in 5 minutes #wordwise", 0),
      p("ig", "INSTAGRAM", "POV: you found the app that does your homework in 5 minutes", 2),
      p("yt", "YOUTUBE", "app that does your homework #shorts", 6),
    ]);
    expect(new Set(links.map((l) => l.groupId))).toEqual(new Set(["auto-ig"]));
    expect(links.map((l) => l.postId).sort()).toEqual(["ig", "tt", "yt"]);
  });

  it("two different videos the same day on the same platform never merge; each twin finds its own", () => {
    const links = matchCrossPosts([
      p("tA", "TIKTOK", "3 apps that cure boredom in class", 0),
      p("tB", "TIKTOK", "3 apps that cure boredom at home", 2),
      p("iA", "INSTAGRAM", "3 apps that cure boredom in class", 1),
    ]);
    expect(links).toEqual([
      { postId: "iA", groupId: "auto-iA" },
      { postId: "tA", groupId: "auto-iA" },
    ]);
  });

  it("a post with no title stays alone", () => {
    expect(
      matchCrossPosts([p("x1", "TIKTOK", null, 0), p("x2", "INSTAGRAM", "", 0), p("x3", "YOUTUBE", "😭 #fyp", 0)]),
    ).toEqual([]);
  });

  it("posts more than 36 h apart are different videos", () => {
    expect(matchCrossPosts([p("o1", "TIKTOK", "same caption here", 0), p("o2", "INSTAGRAM", "same caption here", 37)])).toEqual(
      [],
    );
  });

  it("keeps the owner's manual work: a hand-linked group is not joined, a hand-unlinked post is not moved", () => {
    const links = matchCrossPosts([
      p("m1", "INSTAGRAM", "my morning routine as a student", 0, { video_group_id: "hand", video_group_manual: true }),
      p("m2", "TIKTOK", "my morning routine as a student", 1, { video_group_id: "hand", video_group_manual: true }),
      p("m3", "YOUTUBE", "my morning routine as a student", 2),
      p("m4", "FACEBOOK", "my morning routine as a student", 2, { video_group_manual: true }),
    ]);
    expect(links).toEqual([]);
  });

  it("never links an excluded or hand-priced post (it would zero or reprice the video)", () => {
    expect(
      matchCrossPosts([
        p("e1", "TIKTOK", "study with me for finals", 0, { exclude_from_pay: true }),
        p("e2", "INSTAGRAM", "study with me for finals", 1),
        p("e3", "YOUTUBE", "study with me for finals", 1, { manual_override_cents: 500 }),
      ]),
    ).toEqual([]);
  });

  it("is deterministic and idempotent", () => {
    const rows = [
      p("b1", "TIKTOK", "day in my life at college", 0),
      p("b2", "INSTAGRAM", "day in my life at college", 1),
      p("b3", "YOUTUBE", "day in my life at college", 2),
      p("b4", "FACEBOOK", "day in my life at college", 3),
      p("b5", "TIKTOK", "rating every dining hall", 5),
      p("b6", "INSTAGRAM", "rating every dining hall", 6),
    ];
    const once = matchCrossPosts(rows);
    expect(matchCrossPosts([...rows].reverse())).toEqual(once);
    expect(new Set(once.map((l) => l.groupId))).toEqual(new Set(["auto-b1", "auto-b5"]));
    expect(matchCrossPosts(applyLinks(rows, once))).toEqual([]);
  });
});

// ─── Ledger proof ────────────────────────────────────────────────────────────

const deal: DealRow = {
  id: "deal-wordwise",
  brand_name: "Wordwise",
  status: "active",
  start_date: "2026-11-01",
  end_date: null,
  per_deal_model: false,
  view_aggregation_mode: "HIGHEST",
  daily_target_posts: 1,
  flat_rate_cents: null,
  base_pay_cents: 3500,
  base_min_views: 0,
  view_bonuses: [
    { views: 10_000, bonusCents: 2000 },
    { views: 50_000, bonusCents: 5000 },
  ],
  view_bonus_mode: "ADD",
  cpm_rate: null,
  cpm_view_unit: 1000,
  cpm_cap_views: null,
  cpm_min_views: null,
  cpm_tiers: [],
  cpm_mode: "ADD",
  cpm_tier_mode: "PER_VIDEO",
};

function row(id: string, platform: string, hours: number, views: number): PlanPost {
  return {
    id,
    deal_id: deal.id,
    platform,
    title: "this app writes my essays for me #wordwise",
    posted_at: at(hours),
    video_group_id: null,
    exclude_from_pay: false,
    manual_override_cents: null,
    base_pay_cents_snap: deal.base_pay_cents,
    base_min_views_snap: 0,
    view_bonuses_snap: deal.view_bonuses,
    view_bonus_mode_snap: "ADD",
    cpm_rate_snap: null,
    cpm_view_unit_snap: 1000,
    cpm_cap_views_snap: null,
    cpm_min_views_snap: null,
    cpm_tiers_snap: [],
    cpm_mode_snap: "ADD",
    cpm_tier_mode_snap: "PER_VIDEO",
    payable_views: views,
  };
}

describe("one video on 4 platforms pays once", () => {
  const twins = [row("v-tt", "TIKTOK", 0, 60_000), row("v-ig", "INSTAGRAM", 2, 12_000), row("v-yt", "YOUTUBE", 3, 3_000), row("v-fb", "FACEBOOK", 5, 500)];

  it("unlinked twins were paid 4 times: $85 + $55 + $35 + $35", () => {
    const e = dealEarnings(deal, twins as PostRow[], "UTC", "2026-11-20");
    expect(e.videos).toHaveLength(4);
    expect(e.earnedCents).toBe(21_000);
  });

  it("linked, it pays once on the max-views platform with the bonus tier from that max", () => {
    const linked = applyLinks(twins, matchCrossPosts(twins));
    const e = dealEarnings(deal, linked as PostRow[], "UTC", "2026-11-20");
    expect(e.videos).toHaveLength(1);
    expect(e.videos[0]).toMatchObject({ views: 60_000, baseCents: 3500, bonusCents: 5000, payCents: 8500 });
    expect(e.earnedCents).toBe(8500);
  });

  it("the backfill plan prints the before and after from the same ledger", () => {
    const [plan] = planCrossPosts([deal], twins, "UTC", "2026-11-20");
    expect(plan).toMatchObject({ posts: 4, groupsBefore: 4, groupsAfter: 1, postsLinked: 4, earnedBeforeCents: 21_000, earnedAfterCents: 8500 });
    expect(formatPlan([plan])).toContain("earned $210.00 -> $85.00 (-$125.00: same-rate videos -$125.00, 0 mixed-rate videos $0.00), held 0");
  });
});

// ─── Review findings (fix/ugc-cross-post-2) ─────────────────────────────────

const M = 60_000;
const atMin = (minutes: number) => new Date(T0 + minutes * M).toISOString();
const pm = (id: string, platform: string, title: string, minutes: number, over: Partial<MatchPost> = {}): MatchPost => ({
  id,
  platform,
  title,
  posted_at: atMin(minutes),
  video_group_id: null,
  ...over,
});

describe("time signal: a different caption posted minutes apart is one video (Ripple's 10 min rule)", () => {
  it.each([
    ["At this point imma give up", "Lowkey just gotta give up", 1],
    ["Bro is actually ragebaiting me", "How did bro get into college", 2.5],
    ["It's a struggle fr", "Legit a struggle y'all", 5],
  ])("TikTok %j joins the Instagram group of %j (%d min apart)", (tt, ig, gap) => {
    const links = matchCrossPosts([
      pm("ig", "INSTAGRAM", ig, 0, { video_group_id: "g1" }),
      pm("yt", "YOUTUBE", ig, 1, { video_group_id: "g1" }),
      pm("tt", "TIKTOK", tt, gap),
    ]);
    expect(links).toEqual([{ postId: "tt", groupId: "g1" }]);
  });

  it("two unlinked posts with different captions 3 min apart become one video", () => {
    expect(matchCrossPosts([pm("a", "TIKTOK", "At this point imma give up", 0), pm("b", "INSTAGRAM", "Lowkey just gotta give up", 3)])).toEqual([
      { postId: "a", groupId: "auto-a" },
      { postId: "b", groupId: "auto-a" },
    ]);
  });

  it("more than 10 min apart with different captions stays apart", () => {
    expect(matchCrossPosts([pm("a", "TIKTOK", "At this point imma give up", 0), pm("b", "INSTAGRAM", "Lowkey just gotta give up", 11)])).toEqual([]);
  });

  it("a title twin wins over a closer post with another caption", () => {
    const links = matchCrossPosts([
      pm("tt", "TIKTOK", "rating every dining hall on campus", 0),
      pm("ig-other", "INSTAGRAM", "my morning routine", 2),
      pm("ig-twin", "INSTAGRAM", "rating every dining hall on campus", 40),
    ]);
    expect(links).toEqual([
      { postId: "ig-twin", groupId: "auto-ig-twin" },
      { postId: "tt", groupId: "auto-ig-twin" },
    ]);
  });
});

describe("far apart, a template caption is not the same video", () => {
  const gA = [
    { ...pm("ig-ai", "INSTAGRAM", "Ai is the method🙌", 0), posted_at: "2026-02-23T21:22:00Z", video_group_id: "gA" },
    { ...pm("yt-ai", "YOUTUBE", "Ai is the method🙌", 0), posted_at: "2026-02-23T21:30:00Z", video_group_id: "gA" },
  ];
  it("0.6 word overlap 23.6 h apart does not link", () => {
    expect(matchCrossPosts([...gA, { ...pm("tt-this", "TIKTOK", "This is the method🙌🙌", 0), posted_at: "2026-02-24T20:56:00Z" }])).toEqual([]);
  });
  it("the same 0.6 overlap 2 h apart still links, and the same title a day later still links", () => {
    expect(matchCrossPosts([...gA, { ...pm("tt", "TIKTOK", "This is the method🙌🙌", 0), posted_at: "2026-02-23T23:22:00Z" }])).toEqual([
      { postId: "tt", groupId: "gA" },
    ]);
    expect(matchCrossPosts([...gA, { ...pm("tt", "TIKTOK", "Ai is the method", 0), posted_at: "2026-02-24T20:56:00Z" }])).toEqual([
      { postId: "tt", groupId: "gA" },
    ]);
  });
});

describe("an added number is not a different video", () => {
  it("'3 apps that cure boredom' matches '... in 2026'; pt 2 vs pt 3 still differ", () => {
    expect(titleSimilarity(titleTokens("3 apps that cure boredom"), titleTokens("3 apps that cure boredom in 2026"))).toBeGreaterThan(0);
    expect(titleSimilarity(titleTokens("worst classes pt 2"), titleTokens("worst classes pt 3"))).toBe(0);
    expect(titleSimilarity(titleTokens("top 3 of 5 apps"), titleTokens("top 3 of 4 apps"))).toBe(0);
  });
});

describe("groups with an override or an exclusion", () => {
  const group = (over: Partial<MatchPost>) => [
    p("ig", "INSTAGRAM", "MHA lowkey the best anime", 0, { video_group_id: "g", ...over }),
    p("yt", "YOUTUBE", "MHA lowkey the best anime", 1, { video_group_id: "g" }),
    p("tt", "TIKTOK", "MHA lowkey the best anime", 0.01),
  ];

  it("a TikTok joins its twin's group with a priced override: the video pays the override once", () => {
    expect(matchCrossPostsDetailed(group({ manual_override_cents: 4500 }))).toEqual({ links: [{ postId: "tt", groupId: "g" }], held: [] });
  });

  it.each([[{ manual_override_cents: 0 }], [{ exclude_from_pay: true }]])(
    "a group that zeroes the video (%j) is held for the owner, not joined",
    (over) => {
      expect(matchCrossPostsDetailed(group(over))).toEqual({ links: [], held: [{ postId: "tt", groupId: "g" }] });
    },
  );

  it("the ledger pays the joined override group once", () => {
    const rows = [row("o-ig", "INSTAGRAM", 0, 9000), row("o-tt", "TIKTOK", 0.01, 20_000)].map((r) => r);
    rows[0] = { ...rows[0], video_group_id: "g", manual_override_cents: 4500 };
    const linked = applyLinks(rows, matchCrossPosts(rows));
    const e = dealEarnings(deal, linked as PostRow[], "UTC", "2026-11-20");
    expect(e.earnedCents).toBe(4500);
    expect(dealEarnings(deal, rows as PostRow[], "UTC", "2026-11-20").earnedCents).toBe(4500 + 5500);
  });
});

describe("a post left alone in an auto- group (two adds raced) rejoins its video", () => {
  it("moves from its lone group into the group that lacks its platform", () => {
    const links = matchCrossPosts([
      p("b-tt", "TIKTOK", "day in my life at college", 0, { video_group_id: "auto-b-tt" }),
      p("c-yt", "YOUTUBE", "day in my life at college", 1, { video_group_id: "auto-b-tt" }),
      p("a-ig", "INSTAGRAM", "day in my life at college", 0.5, { video_group_id: "auto-a-ig" }),
    ]);
    expect(links).toEqual([{ postId: "a-ig", groupId: "auto-b-tt", from: "auto-a-ig" }]);
  });

  it("a lone post in a hand-made or Grokbot group stays", () => {
    expect(
      matchCrossPosts([
        p("tt", "TIKTOK", "day in my life at college", 0),
        p("ig", "INSTAGRAM", "day in my life at college", 0.5, { video_group_id: "bot-1" }),
      ]),
    ).toEqual([{ postId: "tt", groupId: "bot-1" }]);
  });
});

describe("the dry run names repricing apart from the dedupe", () => {
  it("a group whose members carry different rates is marked and its change split out", () => {
    const snap65 = (r: PlanPost): PlanPost => ({ ...r, base_pay_cents_snap: 6500, view_bonuses_snap: [] });
    const noSnap = (r: PlanPost): PlanPost => ({ ...r, base_pay_cents_snap: null, view_bonuses_snap: null });
    const posts = [
      snap65(row("r-ig", "INSTAGRAM", 0, 1000)),
      noSnap(row("r-tt", "TIKTOK", 0.01, 5000)),
      row("s-ig", "INSTAGRAM", 30, 100),
      { ...row("s-tt", "TIKTOK", 30.01, 100), title: "a different video" },
    ];
    posts[2] = { ...posts[2], title: "a different video" };
    const [plan] = planCrossPosts([deal], posts, "UTC", "2026-11-20");
    // r: $65 + $35 before; after, one video at the most-viewed (no snapshot) post's current $35 rate.
    // s: $35 + $35 before; after, $35 at the same rate.
    expect(plan.preview.map((g) => [g.groupId, g.mixedRates])).toEqual([
      ["auto-r-ig", true],
      ["auto-s-ig", false],
    ]);
    expect(plan.mixedRateDeltaCents).toBe(-6500);
    expect(plan.earnedAfterCents - plan.earnedBeforeCents).toBe(-6500 - 3500);
    const text = formatPlan([plan]);
    expect(text).toContain("same-rate videos -$35.00, 1 mixed-rate videos -$65.00");
    expect(text).toContain("auto-r-ig  MIXED RATES");
    expect(text).toContain("base $65.00");
  });
});

describe("the backfill write", () => {
  it("moves a lone auto- post only from the group the plan saw, an unlinked post only from none", () => {
    const sql = writeSql([
      { postId: "00000000-0000-4000-8000-000000000001", groupId: "auto-x", from: "auto-o'1" },
      { postId: "00000000-0000-4000-8000-000000000002", groupId: "auto-x" },
    ]);
    expect(sql).toContain("('00000000-0000-4000-8000-000000000001'::uuid, 'auto-x', 'auto-o''1')");
    expect(sql).toContain("('00000000-0000-4000-8000-000000000002'::uuid, 'auto-x', null)");
    expect(sql).toContain("p.video_group_id is not distinct from l.f and not p.video_group_manual");
  });
});

describe("needsMatching", () => {
  it("lists an unlinked pair once, with the reason and the gap", () => {
    const out = needsMatching([
      p("a1", "TIKTOK", "this app writes my essays", 0),
      p("a2", "INSTAGRAM", "this app writes my essays", 0.2),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].postId).toBe("a2");
    expect(out[0].twins[0]).toMatchObject({ twinId: "a1", groupId: null, reason: "title", gapMs: 0.2 * H, zeroes: false });
  });

  it("a time-only twin (any caption, within 10 min) ranks below a title twin", () => {
    const out = needsMatching([
      p("tt", "TIKTOK", "watch this video", 0),
      p("yt", "YOUTUBE", "unrelated words here", 0.1),
      p("ig", "INSTAGRAM", "watch this video", 3),
    ]);
    const ig = out.find((x) => x.postId === "ig")!;
    expect(ig.twins.map((t) => [t.twinId, t.reason])).toEqual([["tt", "title"]]);
    const yt = out.find((x) => x.postId === "yt")!;
    expect(yt.twins.map((t) => [t.twinId, t.reason])).toEqual([["tt", "time"]]);
  });

  it("a held post: its twin's video is excluded, so linking pays $0", () => {
    const out = needsMatching([
      p("a1", "TIKTOK", "worst classes pt 3", 0, { video_group_id: "g1", exclude_from_pay: true }),
      p("a2", "YOUTUBE", "worst classes pt 3", 0, { video_group_id: "g1" }),
      p("a3", "INSTAGRAM", "worst classes pt 3", 1),
    ]);
    expect(out).toEqual([{ postId: "a3", twins: [expect.objectContaining({ groupId: "g1", zeroes: true })] }]);
  });

  it("never lists or suggests a post the owner unlinked, nor a video that has the platform", () => {
    expect(
      needsMatching([
        p("a1", "TIKTOK", "same title here", 0, { video_group_manual: true }),
        p("a2", "INSTAGRAM", "same title here", 0.1),
      ]),
    ).toEqual([]);
    expect(
      needsMatching([
        p("a1", "TIKTOK", "same title here", 0, { video_group_id: "g" }),
        p("a2", "INSTAGRAM", "same title here", 0, { video_group_id: "g" }),
        p("a3", "TIKTOK", "same title here", 0.1),
      ]),
    ).toEqual([]);
  });

  it("a linked video is not listed; a hand-linked one can still be a twin", () => {
    const out = needsMatching([
      p("a1", "TIKTOK", "same title here", 0, { video_group_id: "m", video_group_manual: true }),
      p("a2", "INSTAGRAM", "same title here", 0.5),
    ]);
    expect(out.map((x) => x.postId)).toEqual(["a2"]);
    expect(out[0].twins[0].groupId).toBe("m");
  });
});
