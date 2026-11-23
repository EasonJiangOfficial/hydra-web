import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { addDays } from "@/lib/planning/dates";
import { incomeSummary, netWorthSeries, spendingByCategory } from "@/lib/reports/queries";
import { dayKeysBetween, zonedDayStart } from "@/lib/ugc/days";
import { ugcDealsOnly } from "@/lib/ugc/personal";
import { earnedPerDay, postingCalendarMonth } from "@/lib/ugc/queries";

import type { DayRange, MetricSource, PostingDay } from "./source";

/** earnedPerDay takes at most 1000 days. */
const MAX_EARNED_DAYS = 1000;
const IN_CHUNK = 150;
const PAGE = 1000;

const months = (range: DayRange): string[] => [...new Set(dayKeysBetween(range.from, range.to).map((d) => d.slice(0, 7)))];

/**
 * The live MetricSource: money from the U5 report functions (scope "all"), UGC earned and the
 * posting calendar from the U1 queries, views straight from the UGC tables. `db` is the signed-in
 * owner's client (RLS applies).
 */
export function createLiveSource(db: SupabaseClient, now: Date = new Date()): MetricSource {
  return {
    async netWorthCents(asOf) {
      const { points } = await netWorthSeries(db, "all", { from: asOf, to: asOf });
      return points.at(-1)?.netCents ?? null;
    },

    async incomeCents(range) {
      return (await incomeSummary(db, "all", range)).incomeCents;
    },

    async spending(range) {
      const { rows, totalCents } = await spendingByCategory(db, "all", range);
      return { totalCents, rows: rows.map((r) => ({ categoryId: r.categoryId, name: r.name, cents: r.cents })) };
    },

    async ugcEarnedCents(range) {
      // ponytail: a goal longer than 1000 days counts its last 1000; split the range if one ever needs more.
      const from = dayKeysBetween(range.from, range.to).length > MAX_EARNED_DAYS ? addDays(range.to, -(MAX_EARNED_DAYS - 1)) : range.from;
      const { days } = await earnedPerDay({ from, to: range.to, now });
      return days.reduce((n, d) => n + d.cents, 0);
    },

    async postingDays(range) {
      // ponytail: postingCalendarMonth reloads the UGC ledger per month; add a ranged read if this gets slow.
      const calendars = await Promise.all(months(range).map((month) => postingCalendarMonth({ month, now })));
      const out: PostingDay[] = calendars.flatMap((cal) =>
        cal.days.filter((d) => d.date >= range.from && d.date <= range.to).map((d) => ({ date: d.date, posted: d.posted, target: d.target })),
      );
      return out.sort((a, b) => (a.date < b.date ? -1 : 1));
    },

    async views(range, timeZone) {
      const from = zonedDayStart(range.from, timeZone).toISOString();
      const to = zonedDayStart(addDays(range.to, 1), timeZone).toISOString();
      // The Personal Brand deal (0140) is not UGC work. `select("*")` and ugcDealsOnly, so a database from
      // before 0140 (no column) still reads.
      const deals = await db.from("deals").select("*");
      if (deals.error) throw new Error(`deals: ${deals.error.message}`);
      const { has } = ugcDealsOnly((deals.data ?? []) as { id: string; personal_brand?: boolean | null }[]);
      const posts: { id: string; deal_id: string; video_group_id: string | null }[] = [];
      for (let start = 0; ; start += PAGE) {
        const { data, error } = await db
          .from("posts")
          .select("id, deal_id, video_group_id")
          .eq("exclude_from_pay", false)
          .gte("posted_at", from)
          .lt("posted_at", to)
          .order("id")
          .range(start, start + PAGE - 1);
        if (error) throw new Error(`posts: ${error.message}`);
        posts.push(...(data ?? []).filter(has));
        if ((data?.length ?? 0) < PAGE) break;
      }
      const viewsOf = new Map<string, number>();
      for (let i = 0; i < posts.length; i += IN_CHUNK) {
        const { data, error } = await db
          .from("ugc_post_views")
          .select("post_id, payable_views, latest_views")
          .in("post_id", posts.slice(i, i + IN_CHUNK).map((p) => p.id));
        if (error) throw new Error(`ugc_post_views: ${error.message}`);
        for (const r of data ?? []) viewsOf.set(r.post_id as string, Number(r.payable_views ?? r.latest_views ?? 0));
      }
      // One video on several accounts is paid once, on its best account: count it once, at its best.
      // ponytail: always the HIGHEST rule; a deal set to COMBINED would sum them instead.
      const videos = new Map<string, number>();
      for (const p of posts) {
        const key = p.video_group_id ? `g:${p.video_group_id}` : `p:${p.id}`;
        videos.set(key, Math.max(videos.get(key) ?? 0, viewsOf.get(p.id) ?? 0));
      }
      return { posts: videos.size, views: [...videos.values()].reduce((n, v) => n + v, 0) };
    },
  };
}
