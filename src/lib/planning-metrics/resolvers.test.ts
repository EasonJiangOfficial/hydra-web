import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/planning/dates";
import { createMetricRegistry, goalWindow, type MetricContext } from "@/lib/planning/metrics";

import { createResolvers, streakEndingToday } from "./resolvers";
import type { DayRange, MetricSource, PostingDay } from "./source";

const TODAY = "2026-11-21";

const ctx = (over: Partial<MetricContext> = {}): MetricContext => ({
  goalId: "g",
  window: { from: "2026-11-01", to: "2026-12-31" },
  today: TODAY,
  timeZone: "America/Toronto",
  tasks: [],
  statuses: [],
  ...over,
});

/** A source over plain data: 3 posted against a target of 3 on every day. */
function source(over: Partial<MetricSource> = {}): MetricSource {
  return {
    netWorthCents: async () => 4_821_250,
    incomeCents: async () => 640_000,
    spending: async () => ({
      totalCents: 440_000,
      rows: [
        { categoryId: "c1", name: "Food", cents: 42_050 },
        { categoryId: null, name: "Uncategorized", cents: 5_000 },
      ],
    }),
    ugcEarnedCents: async () => 315_000,
    postingDays: async (r) => {
      const out: PostingDay[] = [];
      for (let d = r.from; d <= r.to; d = addDays(d, 1)) out.push({ date: d, posted: 3, target: 3 });
      return out;
    },
    views: async () => ({ posts: 20, views: 182_000 }),
    ...over,
  };
}

const run = (key: keyof ReturnType<typeof createResolvers>, param: string | null, c: MetricContext, s = source()) =>
  createResolvers(s)[key]!(param, c);

describe("metric resolvers", () => {
  it("net worth and income come back in dollars", async () => {
    expect(await run("net_worth", null, ctx())).toBe(48_212.5);
    expect(await run("monthly_income", null, ctx())).toBe(6400);
  });

  it("net worth is null with no balance stored", async () => {
    expect(await run("net_worth", null, ctx(), source({ netWorthCents: async () => null }))).toBeNull();
  });

  it("savings rate is the share of income kept, null with no income", async () => {
    expect(await run("savings_rate", null, ctx())).toBe(31.3);
    expect(await run("savings_rate", null, ctx(), source({ incomeCents: async () => 0 }))).toBeNull();
    expect(await run("savings_rate", null, ctx(), source({ spending: async () => ({ totalCents: 700_000, rows: [] }) }))).toBe(-9.4);
  });

  it("category spend finds the category by name or id, and is 0 when nothing was spent", async () => {
    expect(await run("category_spend", "food", ctx())).toBe(420.5);
    expect(await run("category_spend", "c1", ctx())).toBe(420.5);
    expect(await run("category_spend", "Rent", ctx())).toBe(0);
    expect(await run("category_spend", null, ctx())).toBeNull();
  });

  it("a goal that has not started has nothing to count", async () => {
    const future = ctx({ window: { from: "2026-12-01", to: "2026-12-31" } });
    for (const key of ["ugc_revenue", "category_spend", "posts_per_day", "total_views", "views_per_post"] as const) {
      expect(await run(key, "Food", future)).toBeNull();
    }
  });

  it("the window is cut at today", async () => {
    const seen: DayRange[] = [];
    await run("ugc_revenue", null, ctx(), source({ ugcEarnedCents: async (r) => (seen.push(r), 0) }));
    expect(seen).toEqual([{ from: "2026-11-01", to: TODAY }]);
  });

  it("posts per day averages over the days so far", async () => {
    expect(await run("posts_per_day", null, ctx())).toBe(3);
    const half = source({ postingDays: async () => [{ date: "2026-11-20", posted: 1, target: 3 }, { date: TODAY, posted: 2, target: 3 }] });
    expect(await run("posts_per_day", null, ctx(), half)).toBe(1.5);
    expect(await run("posts_per_day", null, ctx(), source({ postingDays: async () => [] }))).toBeNull();
  });

  it("views per post is total views over counted posts", async () => {
    expect(await run("total_views", null, ctx())).toBe(182_000);
    expect(await run("views_per_post", null, ctx())).toBe(9100);
    expect(await run("views_per_post", null, ctx(), source({ views: async () => ({ posts: 0, views: 0 }) }))).toBeNull();
  });

  it("goalWindow feeds it: a goal with no start date begins the day it was made", () => {
    const w = goalWindow({ startDate: null, deadline: null, createdAt: "2026-11-10T15:00:00.000Z" }, TODAY, "America/Toronto");
    expect(w).toEqual({ from: "2026-11-10", to: TODAY });
  });

  it("registers into the registry as live (not stub) values", async () => {
    let registry = createMetricRegistry();
    for (const [key, fn] of Object.entries(createResolvers(source()))) registry = registry.register(key as never, fn);
    expect(await registry.resolve("net_worth", null, ctx())).toEqual({ value: 48_212.5, stub: false });
    expect(registry.has("task_progress")).toBe(true);
  });
});

describe("streak", () => {
  const day = (date: string, posted: number, target = 3) => ({ date, posted, target });
  it("counts back from today while the target is hit", () => {
    const days = [day("2026-11-18", 1), day("2026-11-19", 3), day("2026-11-20", 4), day("2026-11-21", 3)];
    expect(streakEndingToday(days, "2026-11-21")).toBe(3);
  });
  it("today still open does not break the run", () => {
    const days = [day("2026-11-19", 3), day("2026-11-20", 3), day("2026-11-21", 1)];
    expect(streakEndingToday(days, "2026-11-21")).toBe(2);
  });
  it("a missed day ends it; a day off neither counts nor breaks", () => {
    const days = [day("2026-11-18", 3), day("2026-11-19", 0), day("2026-11-20", 3), day("2026-11-21", 3)];
    expect(streakEndingToday(days, "2026-11-21")).toBe(2);
    const off = [day("2026-11-18", 3), day("2026-11-19", 3), day("2026-11-20", 0, 0), day("2026-11-21", 3)];
    expect(streakEndingToday(off, "2026-11-21")).toBe(3);
  });
  it("the resolver reports null with no targets at all, 0 when behind", async () => {
    const none = source({ postingDays: async () => [{ date: TODAY, posted: 0, target: 0 }] });
    expect(await run("streak", null, ctx(), none)).toBeNull();
    const behind = source({ postingDays: async () => [{ date: "2026-11-20", posted: 0, target: 3 }, { date: TODAY, posted: 0, target: 3 }] });
    expect(await run("streak", null, ctx(), behind)).toBe(0);
  });
});
