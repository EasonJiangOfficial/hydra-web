/**
 * Hydra's UGC ledger (DESIGN.md section 8): per-video pay, the per-deal model,
 * rate snapshots, exclude, video groups paid once, missed money, projection,
 * owed, and day attribution across month ends and DST with an injected zone.
 */
import { describe, it, expect } from "vitest";
import {
  countedByDay,
  dealEarnings,
  earnedByDay,
  missedMoney,
  nextPausedSpans,
  owedCents,
  postingCalendar,
  projectedMonthlyCents,
  summarizeDeal,
  targetOn,
  type DealRow,
  type PostRow,
} from "@/lib/ugc/ledger";
import { dayKeyInZone } from "@/lib/ugc/days";

const NY = "America/New_York";
const UTC = "UTC";

function deal(over: Partial<DealRow> = {}): DealRow {
  return {
    id: "deal-1",
    brand_name: "Glow",
    status: "active",
    start_date: "2026-11-01",
    end_date: null,
    per_deal_model: false,
    view_aggregation_mode: "HIGHEST",
    daily_target_posts: 1,
    flat_rate_cents: null,
    base_pay_cents: 2500,
    base_min_views: 0,
    view_bonuses: [],
    view_bonus_mode: "REPLACE",
    cpm_rate: null,
    cpm_view_unit: 1000,
    cpm_cap_views: null,
    cpm_min_views: null,
    cpm_tiers: [],
    cpm_mode: "ADD",
    cpm_tier_mode: "PER_VIDEO",
    ...over,
  };
}

/** A post snapshotted from `d` at insert, as the database trigger does. */
function post(d: DealRow, over: Partial<PostRow> & { id: string; posted_at: string }): PostRow {
  return {
    deal_id: d.id,
    video_group_id: null,
    exclude_from_pay: false,
    manual_override_cents: null,
    base_pay_cents_snap: d.base_pay_cents,
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
    payable_views: null,
    ...over,
  };
}

/** $25 base, bonus $50 at 10k and $200 at 100k, CPM $2 per 1,000. */
const STACKED = deal({
  view_bonuses: [
    { views: 10_000, bonusCents: 5_000 },
    { views: 100_000, bonusCents: 20_000 },
  ],
  cpm_rate: 2,
});

describe("per-video pay (the default model)", () => {
  const cases: {
    name: string;
    d: DealRow;
    views: number | null;
    pay: number;
    base: number;
    bonus: number;
    cpm: number;
  }[] = [
    { name: "base + CPM, under every tier", d: STACKED, views: 5_000, pay: 3_500, base: 2_500, bonus: 0, cpm: 1_000 },
    { name: "REPLACE: the 10k tier beats base", d: STACKED, views: 50_000, pay: 15_000, base: 2_500, bonus: 2_500, cpm: 10_000 },
    { name: "the highest tier this video passes", d: STACKED, views: 150_000, pay: 50_000, base: 2_500, bonus: 17_500, cpm: 30_000 },
    {
      name: "ADD: bonus on top of base",
      d: deal({ ...STACKED, view_bonus_mode: "ADD" }),
      views: 50_000,
      pay: 17_500,
      base: 2_500,
      bonus: 5_000,
      cpm: 10_000,
    },
    {
      name: "base gated by min views",
      d: deal({ base_min_views: 1_000 }),
      views: 999,
      pay: 0,
      base: 0,
      bonus: 0,
      cpm: 0,
    },
    {
      name: "no reading yet still pays base (no minimum)",
      d: deal(),
      views: null,
      pay: 2_500,
      base: 2_500,
      bonus: 0,
      cpm: 0,
    },
    {
      name: "cpm REPLACE: the better lane wins",
      d: deal({ cpm_rate: 2, cpm_mode: "REPLACE" }),
      views: 50_000,
      pay: 10_000,
      base: 0,
      bonus: 0,
      cpm: 10_000,
    },
    {
      name: "cpm REPLACE: base wins on a small video",
      d: deal({ cpm_rate: 2, cpm_mode: "REPLACE" }),
      views: 5_000,
      pay: 2_500,
      base: 2_500,
      bonus: 0,
      cpm: 0,
    },
    {
      name: "CPM floor and cap",
      d: deal({ base_pay_cents: null, cpm_rate: 2, cpm_min_views: 10_000, cpm_cap_views: 100_000 }),
      views: 250_000,
      pay: 18_000,
      base: 0,
      bonus: 0,
      cpm: 18_000,
    },
  ];
  it.each(cases)("$name", ({ d, views, pay, base, bonus, cpm }) => {
    const e = dealEarnings(d, [post(d, { id: "p1", posted_at: "2026-11-02T15:00:00Z", payable_views: views })], UTC, "2026-11-30");
    expect(e.videos[0]).toMatchObject({ payCents: pay, baseCents: base, bonusCents: bonus, cpmCents: cpm });
    expect(e.earnedCents).toBe(pay);
  });

  it("each video matches its own bonus tier (per video, not summed)", () => {
    const posts = [5_000, 50_000, 150_000].map((v, i) =>
      post(STACKED, { id: `p${i}`, posted_at: `2026-11-0${i + 2}T15:00:00Z`, payable_views: v }),
    );
    expect(dealEarnings(STACKED, posts, UTC, "2026-11-30").earnedCents).toBe(3_500 + 15_000 + 50_000);
  });
});

describe("per-deal model (deal setting, off by default)", () => {
  const d = deal({ ...STACKED, per_deal_model: true });
  const posts = [5_000, 50_000, 150_000].map((v, i) =>
    post(d, { id: `p${i}`, posted_at: `2026-11-0${i + 2}T15:00:00Z`, payable_views: v }),
  );
  const e = dealEarnings(d, posts, UTC, "2026-11-30");

  it("pays one bonus on the summed views: max($75 base, $200) + $410 CPM", () => {
    expect(e.earnedCents).toBe(61_000);
  });

  it("puts the aggregate above the rows on the latest video's day, so days sum to the total", () => {
    expect(e.bonusDeltaCents).toBe(61_000 - (3_500 + 12_500 + 32_500));
    expect(e.bonusDeltaDay).toBe("2026-11-04");
    const days = earnedByDay(d, e);
    expect([...days.values()].reduce((a, b) => a + b, 0)).toBe(e.earnedCents);
  });
});

describe("rate snapshot", () => {
  const current = deal({ base_pay_cents: 4_000 });

  it("an old post keeps the rate it was added with", () => {
    const old = post(deal({ base_pay_cents: 2_500 }), { id: "p1", posted_at: "2026-11-02T15:00:00Z" });
    expect(dealEarnings(current, [old], UTC, "2026-11-30").earnedCents).toBe(2_500);
  });

  it("a new post takes the current rate", () => {
    const fresh = post(current, { id: "p2", posted_at: "2026-11-03T15:00:00Z" });
    expect(dealEarnings(current, [fresh], UTC, "2026-11-30").earnedCents).toBe(4_000);
  });

  it("an imported post without any snapshot falls back to the deal's rate", () => {
    const imported = post(current, {
      id: "p3",
      posted_at: "2026-10-03T15:00:00Z",
      base_pay_cents_snap: null,
      view_bonuses_snap: null,
      cpm_rate_snap: null,
      cpm_tiers_snap: null,
    });
    expect(dealEarnings(current, [imported], UTC, "2026-11-30").earnedCents).toBe(4_000);
  });

  it("an explicit empty bonus table is a snapshot, so later bonuses never reprice it", () => {
    const before = post(deal(), { id: "p4", posted_at: "2026-11-02T15:00:00Z", payable_views: 50_000 });
    const withBonus = deal({ view_bonuses: [{ views: 10_000, bonusCents: 9_000 }] });
    expect(dealEarnings(withBonus, [before], UTC, "2026-11-30").earnedCents).toBe(2_500);
  });
});

describe("exclude, override and one video on several accounts", () => {
  const d = deal({ base_min_views: 2_000, daily_target_posts: 1 });
  const at = "2026-11-02T15:00:00Z";
  const cases: {
    name: string;
    d?: DealRow;
    posts: (Partial<PostRow> & { id: string })[];
    videos: number;
    earned: number;
    counted: number;
  }[] = [
    {
      name: "an excluded video pays $0 and does not count",
      posts: [{ id: "a", payable_views: 5_000, exclude_from_pay: true }],
      videos: 1,
      earned: 0,
      counted: 0,
    },
    {
      name: "a manual override is the video's pay",
      posts: [{ id: "a", payable_views: 10, manual_override_cents: 9_999 }],
      videos: 1,
      earned: 9_999,
      counted: 1,
    },
    {
      name: "a video group is paid once on its best account (HIGHEST)",
      posts: [
        { id: "a", video_group_id: "g1", payable_views: 1_000 },
        { id: "b", video_group_id: "g1", payable_views: 3_000 },
      ],
      videos: 1,
      earned: 2_500,
      counted: 1,
    },
    {
      name: "HIGHEST: the best account misses the minimum, so no base",
      d: deal({ base_min_views: 3_500 }),
      posts: [
        { id: "a", video_group_id: "g1", payable_views: 1_000 },
        { id: "b", video_group_id: "g1", payable_views: 3_000 },
      ],
      videos: 1,
      earned: 0,
      counted: 1,
    },
    {
      name: "COMBINED: the summed views clear the minimum",
      d: deal({ base_min_views: 3_500, view_aggregation_mode: "COMBINED" }),
      posts: [
        { id: "a", video_group_id: "g1", payable_views: 1_000 },
        { id: "b", video_group_id: "g1", payable_views: 3_000 },
      ],
      videos: 1,
      earned: 2_500,
      counted: 1,
    },
    {
      name: "one excluded member zeroes the whole group",
      posts: [
        { id: "a", video_group_id: "g1", payable_views: 5_000 },
        { id: "b", video_group_id: "g1", payable_views: 5_000, exclude_from_pay: true },
      ],
      videos: 1,
      earned: 0,
      counted: 0,
    },
    {
      name: "posts without a group are separate videos",
      posts: [
        { id: "a", payable_views: 5_000 },
        { id: "b", payable_views: 5_000 },
      ],
      videos: 2,
      earned: 5_000,
      counted: 2,
    },
  ];
  it.each(cases)("$name", ({ d: dd = d, posts, videos, earned, counted }) => {
    const e = dealEarnings(dd, posts.map((p) => post(dd, { posted_at: at, ...p })), UTC, "2026-11-30");
    expect(e.videos).toHaveLength(videos);
    expect(e.earnedCents).toBe(earned);
    expect(countedByDay(e).get("2026-11-02") ?? 0).toBe(counted);
  });

  it("a group counts on its earliest post's day", () => {
    const e = dealEarnings(
      d,
      [
        post(d, { id: "a", video_group_id: "g1", posted_at: "2026-11-03T15:00:00Z", payable_views: 5_000 }),
        post(d, { id: "b", video_group_id: "g1", posted_at: "2026-11-02T15:00:00Z", payable_views: 100 }),
      ],
      UTC,
      "2026-11-30",
    );
    expect([...countedByDay(e)]).toEqual([["2026-11-02", 1]]);
  });

  it("ignores posts of other deals", () => {
    const other = deal({ id: "deal-2" });
    const e = dealEarnings(d, [post(other, { id: "x", posted_at: at, payable_views: 9_000 })], UTC, "2026-11-30");
    expect(e.videos).toHaveLength(0);
  });
});

describe("flat rate", () => {
  it("is earned once, on the start day, once that day has come", () => {
    const d = deal({ flat_rate_cents: 10_000, start_date: "2026-11-05" });
    expect(dealEarnings(d, [], UTC, "2026-11-04").earnedCents).toBe(0);
    const e = dealEarnings(d, [], UTC, "2026-11-05");
    expect(e.earnedCents).toBe(10_000);
    expect([...earnedByDay(d, e)]).toEqual([["2026-11-05", 10_000]]);
  });
});

describe("missed money", () => {
  // Base $25, target 2 a day, started Nov 1.
  const base = deal({ daily_target_posts: 2 });
  const cases: {
    name: string;
    d?: DealRow;
    counted: Record<string, number>;
    overrides?: Record<string, number>;
    today: string;
    cents: number;
    missed: number;
  }[] = [
    { name: "target hit every day", counted: { "2026-11-01": 2, "2026-11-02": 2 }, today: "2026-11-03", cents: 0, missed: 0 },
    { name: "one video short", counted: { "2026-11-01": 1 }, today: "2026-11-02", cents: 2_500, missed: 1 },
    { name: "two empty days", counted: {}, today: "2026-11-03", cents: 10_000, missed: 4 },
    {
      name: "over-delivery never offsets another day",
      counted: { "2026-11-01": 4 },
      today: "2026-11-03",
      cents: 5_000,
      missed: 2,
    },
    { name: "a day target of 0 is a day off", counted: {}, overrides: { "2026-11-01": 0 }, today: "2026-11-02", cents: 0, missed: 0 },
    {
      name: "a raised day target",
      counted: { "2026-11-01": 2 },
      overrides: { "2026-11-01": 3 },
      today: "2026-11-02",
      cents: 2_500,
      missed: 1,
    },
    { name: "today is not elapsed yet", counted: {}, today: "2026-11-01", cents: 0, missed: 0 },
    { name: "nothing before the start date", d: deal({ daily_target_posts: 2, start_date: "2026-11-05" }), counted: {}, today: "2026-11-05", cents: 0, missed: 0 },
    {
      name: "stops at the end date",
      d: deal({ daily_target_posts: 2, status: "ended", end_date: "2026-11-02" }),
      counted: {},
      today: "2026-11-10",
      cents: 10_000,
      missed: 4,
    },
    { name: "a paused deal misses nothing", d: deal({ daily_target_posts: 2, status: "paused" }), counted: {}, today: "2026-11-03", cents: 0, missed: 0 },
    {
      name: "an ended deal without an end date misses nothing",
      d: deal({ daily_target_posts: 2, status: "ended" }),
      counted: {},
      today: "2026-11-03",
      cents: 0,
      missed: 0,
    },
    {
      name: "no base pay: videos missed, $0 missed",
      d: deal({ daily_target_posts: 2, base_pay_cents: null }),
      counted: {},
      today: "2026-11-02",
      cents: 0,
      missed: 2,
    },
    { name: "a target of 0 misses nothing", d: deal({ daily_target_posts: 0 }), counted: {}, today: "2026-11-05", cents: 0, missed: 0 },
  ];
  it.each(cases)("$name", ({ d = base, counted, overrides, today, cents, missed }) => {
    const r = missedMoney({
      deal: d,
      counted: new Map(Object.entries(counted)),
      overrides: overrides && new Map(Object.entries(overrides)),
      today,
    });
    expect(r.cents).toBe(cents);
    expect(r.missed).toBe(missed);
  });

  it("an excluded video does not count toward the target", () => {
    const d = deal({ daily_target_posts: 1 });
    const e = dealEarnings(
      d,
      [post(d, { id: "a", posted_at: "2026-11-01T15:00:00Z", exclude_from_pay: true })],
      UTC,
      "2026-11-02",
    );
    expect(missedMoney({ deal: d, counted: countedByDay(e), today: "2026-11-02" }).cents).toBe(2_500);
  });

  it("a range keeps only its own days", () => {
    const r = missedMoney({
      deal: base,
      counted: new Map(),
      today: "2026-12-03",
      range: { from: "2026-12-01", to: "2026-12-31" },
    });
    expect([...r.byDay.keys()]).toEqual(["2026-12-01", "2026-12-02"]);
  });
});

describe("projection: target per day x base pay x 30, active deals only", () => {
  const cases: { name: string; d: DealRow; cents: number }[] = [
    { name: "two a day at $25", d: deal({ daily_target_posts: 2 }), cents: 150_000 },
    { name: "a flat 30 days, whatever the month", d: deal({ daily_target_posts: 1, start_date: "2026-02-01" }), cents: 75_000 },
    { name: "paused", d: deal({ status: "paused" }), cents: 0 },
    { name: "ended", d: deal({ status: "ended", end_date: "2026-11-02" }), cents: 0 },
    { name: "target 0", d: deal({ daily_target_posts: 0 }), cents: 0 },
    { name: "no base pay (CPM only)", d: deal({ base_pay_cents: null, cpm_rate: 2 }), cents: 0 },
  ];
  it.each(cases)("$name", ({ d, cents }) => expect(projectedMonthlyCents(d)).toBe(cents));

  it("sums over deals", () => {
    const deals = [deal({ daily_target_posts: 2 }), deal({ id: "d2", base_pay_cents: 1_000 }), deal({ id: "d3", status: "paused" })];
    expect(deals.reduce((s, d) => s + projectedMonthlyCents(d), 0)).toBe(150_000 + 30_000);
  });
});

describe("owed = earned - matched deposits", () => {
  it.each([
    { earned: 10_000, paid: 0, owed: 10_000 },
    { earned: 10_000, paid: 4_000, owed: 6_000 },
    { earned: 10_000, paid: 10_000, owed: 0 },
    { earned: 10_000, paid: 12_000, owed: -2_000 },
  ])("earned $earned, paid $paid → $owed", ({ earned, paid, owed }) => expect(owedCents(earned, paid)).toBe(owed));

  it("summarizes a deal", () => {
    const d = deal({ daily_target_posts: 2 });
    const e = dealEarnings(d, [post(d, { id: "a", posted_at: "2026-11-01T15:00:00Z", payable_views: 100 })], UTC, "2026-11-03");
    expect(summarizeDeal({ deal: d, earnings: e, paidCents: 1_000, today: "2026-11-03" })).toEqual({
      dealId: "deal-1",
      earnedCents: 2_500,
      paidCents: 1_000,
      owedCents: 1_500,
      missedCents: 2_500 + 5_000,
      projectedCents: 150_000,
      videoCount: 1,
    });
  });
});

describe("days in the owner's zone: month ends and DST", () => {
  const d = deal({ start_date: "2026-03-01", daily_target_posts: 1 });
  const dayOf = (iso: string, zone = NY) =>
    dealEarnings(d, [post(d, { id: "p", posted_at: iso })], zone, "2026-12-31").videos[0]!.day;

  it.each([
    { iso: "2026-04-01T03:30:00Z", zone: NY, day: "2026-03-31", why: "23:30 EDT on the last day of March" },
    { iso: "2026-04-01T04:00:00Z", zone: NY, day: "2026-04-01", why: "midnight EDT starts April" },
    { iso: "2026-03-08T06:59:00Z", zone: NY, day: "2026-03-08", why: "01:59 EST before spring forward" },
    { iso: "2026-03-08T07:01:00Z", zone: NY, day: "2026-03-08", why: "03:01 EDT after spring forward" },
    { iso: "2026-11-01T05:30:00Z", zone: NY, day: "2026-11-01", why: "the first 01:30 on fall back" },
    { iso: "2026-11-01T06:30:00Z", zone: NY, day: "2026-11-01", why: "the second 01:30 on fall back" },
    { iso: "2026-11-02T04:59:00Z", zone: NY, day: "2026-11-01", why: "23:59 EST ends the 25-hour day" },
    { iso: "2026-11-30T12:00:00Z", zone: "Pacific/Auckland", day: "2026-12-01", why: "UTC+13 is already December" },
    { iso: "2026-04-01T03:30:00Z", zone: UTC, day: "2026-04-01", why: "the same instant in UTC" },
  ])("$why", ({ iso, zone, day }) => expect(dayOf(iso, zone)).toBe(day));

  it("each DST day is one target day", () => {
    const short = missedMoney({ deal: d, counted: new Map(), today: "2026-03-09", range: { from: "2026-03-08", to: "2026-03-08" } });
    const long = missedMoney({
      deal: deal({ start_date: "2026-10-01" }),
      counted: new Map(),
      today: "2026-11-02",
      range: { from: "2026-11-01", to: "2026-11-01" },
    });
    expect(short.missed).toBe(1);
    expect(long.missed).toBe(1);
  });

  it("an injected now near midnight decides which day is elapsed", () => {
    const now = new Date("2026-03-09T03:30:00Z"); // 23:30 EDT on Mar 8
    const today = dayKeyInZone(now, NY);
    expect(today).toBe("2026-03-08");
    const r = missedMoney({ deal: d, counted: new Map(), today });
    expect([...r.byDay.keys()].at(-1)).toBe("2026-03-07");
    expect(r.missed).toBe(7);
    expect(missedMoney({ deal: d, counted: new Map(), today: dayKeyInZone(now, UTC) }).missed).toBe(8);
  });

  it("earned money lands on the local day across a month end", () => {
    const e = dealEarnings(d, [post(d, { id: "p", posted_at: "2026-04-01T03:30:00Z" })], NY, "2026-04-30");
    expect([...earnedByDay(d, e)]).toEqual([["2026-03-31", 2_500]]);
  });
});

describe("posting calendar", () => {
  it.each([
    { month: "2026-02", days: 28 },
    { month: "2028-02", days: 29 },
    { month: "2026-03", days: 31 },
    { month: "2026-11", days: 30 },
  ])("$month has $days days", ({ month, days }) => {
    expect(postingCalendar({ month, today: "2026-11-15", deals: [] })).toHaveLength(days);
  });

  it("marks hit, under, zero, day off and future, with per-deal cells", () => {
    const d = deal({ daily_target_posts: 2 });
    const posts = [
      post(d, { id: "a", posted_at: "2026-11-01T15:00:00Z" }),
      post(d, { id: "b", posted_at: "2026-11-01T16:00:00Z" }),
      post(d, { id: "c", posted_at: "2026-11-02T15:00:00Z" }),
    ];
    const e = dealEarnings(d, posts, UTC, "2026-11-05");
    const days = postingCalendar({
      month: "2026-11",
      today: "2026-11-05",
      deals: [{ deal: d, earnings: e, overrides: new Map([["2026-11-04", 0]]) }],
    });
    const by = (date: string) => days.find((x) => x.date === date)!;
    expect(by("2026-11-01")).toMatchObject({ status: "hit", posted: 2, target: 2, earnedCents: 5_000, missedCents: 0 });
    expect(by("2026-11-02")).toMatchObject({ status: "under", posted: 1, earnedCents: 2_500, missedCents: 2_500 });
    expect(by("2026-11-03")).toMatchObject({ status: "zero", posted: 0, missedCents: 5_000 });
    expect(by("2026-11-04")).toMatchObject({ status: "none", target: 0, missedCents: 0, deals: [] });
    expect(by("2026-11-05")).toMatchObject({ isToday: true, status: "zero", missedCents: 0 });
    expect(by("2026-11-06")).toMatchObject({ status: "future", target: 2 });
    expect(by("2026-11-02").deals).toEqual([
      { dealId: "deal-1", brandName: "Glow", posted: 1, target: 2, earnedCents: 2_500, missedCents: 2_500 },
    ]);
  });
});

describe("COMBINED cpm tier modes in the per-video model", () => {
  // Two videos at 300k, $1 per 1k, a $2 tier above 500k. No base pay.
  const terms = { base_pay_cents: null, cpm_rate: 1, cpm_tiers: [{ views: 500_000, ratePerUnit: 2 }] };
  const cases: { mode: string; earned: number; perVideo: number[] }[] = [
    { mode: "PER_VIDEO", earned: 60_000, perVideo: [30_000, 30_000] },
    { mode: "COMBINED_BRACKETED", earned: 70_000, perVideo: [35_000, 35_000] },
    { mode: "COMBINED_FLAT", earned: 120_000, perVideo: [60_000, 60_000] },
  ];
  it.each(cases)("$mode earns $earned cents, the same as the per-deal model", ({ mode, earned, perVideo }) => {
    for (const perDeal of [false, true]) {
      const d = deal({ ...terms, cpm_tier_mode: mode, per_deal_model: perDeal });
      const posts = ["p1", "p2"].map((id, i) =>
        post(d, { id, posted_at: `2026-11-0${i + 2}T15:00:00Z`, payable_views: 300_000 }),
      );
      const e = dealEarnings(d, posts, UTC, "2026-11-30");
      expect(e.earnedCents).toBe(earned);
      if (!perDeal) expect(e.videos.map((v) => v.cpmCents)).toEqual(perVideo);
    }
  });

  it("splits the combined CPM by views to the exact cent; base and per-video bonus stay", () => {
    const d = deal({ ...terms, base_pay_cents: 2_500, cpm_tier_mode: "COMBINED_BRACKETED", view_bonuses: [{ views: 400_000, bonusCents: 10_000 }] });
    const posts = [100_001, 450_000].map((v, i) => post(d, { id: `p${i}`, posted_at: `2026-11-0${i + 2}T15:00:00Z`, payable_views: v }));
    const e = dealEarnings(d, posts, UTC, "2026-11-30");
    // 550,001 views: 500k at $1 + 50,001 at $2 = $600.002 -> $600.00.
    expect(e.videos.reduce((s, v) => s + v.cpmCents, 0)).toBe(60_000);
    expect(e.videos.map((v) => [v.baseCents, v.bonusCents])).toEqual([
      [2_500, 0],
      [2_500, 7_500],
    ]);
    expect(e.earnedCents).toBe(60_000 + 2_500 + 10_000);
  });

  it("the newest video's snapshot picks the mode; excluded and overridden videos stay out", () => {
    const d = deal({ ...terms, cpm_tier_mode: "COMBINED_FLAT" });
    const old = post(d, { id: "a", posted_at: "2026-11-02T15:00:00Z", payable_views: 300_000, cpm_tier_mode_snap: "PER_VIDEO" });
    const newer = post(d, { id: "b", posted_at: "2026-11-03T15:00:00Z", payable_views: 300_000 });
    const skipped = post(d, { id: "c", posted_at: "2026-11-04T15:00:00Z", payable_views: 900_000, exclude_from_pay: true });
    const fixed = post(d, { id: "e", posted_at: "2026-11-01T15:00:00Z", payable_views: 900_000, manual_override_cents: 100 });
    expect(dealEarnings(d, [old, newer, skipped, fixed], UTC, "2026-11-30").earnedCents).toBe(120_000 + 100);
    expect(dealEarnings(d, [old], UTC, "2026-11-30").earnedCents).toBe(30_000);
  });

  it("cpm REPLACE keeps the better lane per video", () => {
    const d = deal({ ...terms, base_pay_cents: 40_000, cpm_mode: "REPLACE", cpm_tier_mode: "COMBINED_FLAT" });
    const posts = [100_000, 500_000].map((v, i) => post(d, { id: `p${i}`, posted_at: `2026-11-0${i + 2}T15:00:00Z`, payable_views: v }));
    // 600k flat at $2 = $1,200: shares $200 and $1,000. Base $400 wins on the first.
    const e = dealEarnings(d, posts, UTC, "2026-11-30");
    expect(e.videos.map((v) => [v.baseCents, v.cpmCents])).toEqual([
      [40_000, 0],
      [0, 100_000],
    ]);
  });
});

describe("pauses keep history", () => {
  // Active from Nov 1, $25 base, 1 a day, no posts.
  const missed = (d: DealRow, today: string) => missedMoney({ deal: d, counted: new Map(), today });
  const cases: { name: string; d: DealRow; today: string; cents: number; missed: number }[] = [
    { name: "active", d: deal(), today: "2026-11-21", cents: 50_000, missed: 20 },
    {
      name: "paused on Nov 21: the 20 days before stay",
      d: deal({ status: "paused", paused_spans: [{ from: "2026-11-21", to: null }] }),
      today: "2026-11-28",
      cents: 50_000,
      missed: 20,
    },
    {
      name: "resumed: only the paused week drops",
      d: deal({ paused_spans: [{ from: "2026-11-21", to: "2026-11-27" }] }),
      today: "2026-11-30",
      cents: 50_000 + 2 * 2_500,
      missed: 22,
    },
    {
      name: "paused, then ended: the paused days stay off",
      d: deal({ status: "ended", end_date: "2026-11-28", paused_spans: [{ from: "2026-11-21", to: "2026-11-27" }] }),
      today: "2026-12-10",
      cents: 50_000 + 2_500,
      missed: 21,
    },
    { name: "an imported pause with no date misses nothing", d: deal({ status: "paused" }), today: "2026-11-21", cents: 0, missed: 0 },
  ];
  it.each(cases)("$name", ({ d, today, cents, missed: n }) => {
    const r = missed(d, today);
    expect([r.cents, r.missed]).toEqual([cents, n]);
  });

  it("the calendar keeps a past target and drops paused days", () => {
    const d = deal({ status: "paused", paused_spans: [{ from: "2026-11-21", to: null }] });
    expect(targetOn(d, "2026-11-05", undefined)).toBe(1);
    expect(targetOn(d, "2026-11-21", undefined)).toBeNull();
    const cal = postingCalendar({ month: "2026-11", today: "2026-11-25", deals: [{ deal: d, earnings: dealEarnings(d, [], UTC, "2026-11-25") }] });
    expect(cal.find((c) => c.date === "2026-11-05")!.status).toBe("zero");
    expect(cal.find((c) => c.date === "2026-11-22")!.status).toBe("none");
  });

  it.each([
    { name: "pause opens a span today", spans: [], from: "active", to: "paused", out: [{ from: "2026-11-21", to: null }] },
    {
      name: "resume closes it on yesterday",
      spans: [{ from: "2026-11-10", to: null }],
      from: "paused",
      to: "active",
      out: [{ from: "2026-11-10", to: "2026-11-20" }],
    },
    { name: "a same-day pause leaves nothing", spans: [{ from: "2026-11-21", to: null }], from: "paused", to: "ended", out: [] },
    { name: "other changes keep the spans", spans: [{ from: "2026-11-01", to: "2026-11-02" }], from: "active", to: "ended", out: [{ from: "2026-11-01", to: "2026-11-02" }] },
  ] as const)("$name", ({ spans, from, to, out }) => {
    expect(nextPausedSpans(spans, from, to, "2026-11-21")).toEqual(out);
  });
});

describe("projection window: [today, today + 29] inside the deal's dates", () => {
  const cases: { name: string; d: DealRow; today: string; cents: number }[] = [
    { name: "open-ended: 30 days", d: deal(), today: "2026-11-21", cents: 75_000 },
    { name: "past its end date: nothing", d: deal({ end_date: "2026-11-10" }), today: "2026-11-21", cents: 0 },
    { name: "ends in 10 days", d: deal({ end_date: "2026-11-30" }), today: "2026-11-21", cents: 10 * 2_500 },
    { name: "starts next March: nothing yet", d: deal({ start_date: "2027-03-01" }), today: "2026-11-21", cents: 0 },
    { name: "starts in 25 days: 5 days", d: deal({ start_date: "2026-12-16" }), today: "2026-11-21", cents: 5 * 2_500 },
    { name: "across a month end (Jan 31 to Feb 15)", d: deal({ start_date: "2026-01-01", end_date: "2026-02-15" }), today: "2026-01-31", cents: 16 * 2_500 },
    { name: "across the DST change (Mar 1 to Mar 10)", d: deal({ start_date: "2026-01-01", end_date: "2026-03-10", daily_target_posts: 2 }), today: "2026-03-01", cents: 2 * 10 * 2_500 },
  ];
  it.each(cases)("$name", ({ d, today, cents }) => expect(projectedMonthlyCents(d, today)).toBe(cents));

  it("summarizeDeal projects with today", () => {
    const d = deal({ end_date: "2026-11-10" });
    expect(summarizeDeal({ deal: d, earnings: dealEarnings(d, [], NY, "2026-11-21"), paidCents: 0, today: "2026-11-21" }).projectedCents).toBe(0);
  });
});
