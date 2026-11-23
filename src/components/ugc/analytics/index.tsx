"use client";

import { useMemo, useState, type ReactNode } from "react";

import { Bars, Button, Card, Donut, InfoDot, Label, ListRow, Money, Pill, Seg, Sparkline, Strip, TrendLine } from "@/components/kit";
import { DatePicker } from "@/components/ui/date-picker";
import {
  LATEST_POSTS_PAGE,
  RANGE_KEYS,
  RANGE_LABEL,
  TOP_VIDEOS_PAGE,
  analyticsPosts,
  cadence,
  consistency,
  earningsSeries,
  engagementTotals,
  inWindow,
  isRangeKey,
  latestPosts,
  platformVideos,
  platformViews,
  splitSeriesDelta,
  topVideos,
  trendDays,
  viewDistribution,
  viewsByDeal,
  viewsPerDay,
  type AnalyticsPost,
  type AnalyticsWindow,
  type PlatformSlice,
  type RangeKey,
  type WithEngagement,
} from "@/lib/ugc/analytics";
import { dayKeyInZone } from "@/lib/ugc/days";
import { earnedByDay } from "@/lib/ugc/ledger";
import type { Platform } from "@/lib/ugc/schemas";

import { SectionLabel } from "../controls";
import { displayUrl, shortDay, visibleDeals } from "../model";
import { periodInstants, type PeriodRange } from "../period";
import { useUgc } from "../store";
import { useQueryParam } from "../url";
import { MonthSeries, RAMP, Reveal, ViewsLines, YearHeatmap, compact } from "./charts";

const PLATFORM_LABEL: Record<Platform, string> = { TIKTOK: "TikTok", INSTAGRAM: "Instagram", YOUTUBE: "YouTube", FACEBOOK: "Facebook" };
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * Ripple's creator analytics, inside Overview: views by deal, posting consistency, engagement and earnings,
 * platform mix, top videos and recent posts. One range picker drives the windowed blocks; the deal picker
 * above the tabs filters every block. Excluded videos count nowhere.
 */
export function UgcAnalytics({ dealId, range }: { dealId: string | null; range: PeriodRange }) {
  const { model, raw } = useUgc();
  const { from, to } = range;
  const lookup = usePostLookup();

  const data = useMemo(() => {
    const zone = model.zone;
    const posts = analyticsPosts(raw as typeof raw & WithEngagement, dealId);
    // The period's instants in the owner's zone. The period still running stops at now (posts ahead of the
    // clock are not in yet); one wholly ahead keeps its own end and shows empty.
    const { start, end } = periodInstants({ from, to }, zone);
    const win: AnalyticsWindow = { from: start, to: end < model.now || start > model.now ? end : model.now };
    const inRange = inWindow(posts, win);
    const days = trendDays(win, posts, zone);
    const earned = new Map<string, number>();
    for (const d of visibleDeals(model, dealId)) {
      for (const [day, cents] of earnedByDay(d.row, d.earnings)) earned.set(day, (earned.get(day) ?? 0) + cents);
    }
    const perDay = viewsPerDay(inRange, days, zone);
    return {
      posts,
      win,
      inRange,
      days,
      byDeal: viewsByDeal(posts, model.deals.map((d) => ({ id: d.deal.id, name: d.deal.brand_name })), win, zone),
      year: consistency(posts, model.now, zone),
      totals: engagementTotals(inRange),
      views: perDay.map((p) => p.total),
      posted: cadence(inRange, days, zone),
      earnings: earningsSeries(earned, days),
      pViews: platformViews(inRange),
      pVideos: platformVideos(inRange),
      dist: viewDistribution(inRange),
    };
  }, [raw, model, dealId, from, to]);

  return (
    <section aria-label="Analytics" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3 pt-3">
        <Label className="text-body font-medium text-ink">Analytics</Label>
        <InfoDot>Views are each post&apos;s latest reading. Excluded videos count nowhere. The period filters every block but posting consistency and recent posts.</InfoDot>
      </div>

      <>
          <Reveal height={300}>
            <ViewsByDealCard data={data.byDeal} />
          </Reveal>
          <Reveal height={220}>
            <ConsistencyCard year={data.year} />
          </Reveal>
          <div className="grid gap-5 lg:grid-cols-12">
            <Reveal height={260} className="lg:col-span-7">
              <EngagementCard totals={data.totals} views={data.views} earnings={data.earnings.map((e) => e.cents)} />
            </Reveal>
            <Reveal height={260} className="lg:col-span-5">
              <EarningsCard series={data.earnings} />
            </Reveal>
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            <Reveal height={340}>
              <PlatformCard
                title="Views by platform"
                unit="views"
                mix={data.pViews}
                calendar={data.views.map((v, i) => ({ day: data.days[i], value: v }))}
                format={compact}
                today={model.today}
              />
            </Reveal>
            <Reveal height={340}>
              <PlatformCard
                title="Videos by platform"
                unit="posts"
                mix={data.pVideos}
                calendar={data.posted.map((p) => ({ day: p.day, value: p.posts }))}
                format={(n) => String(n)}
                today={model.today}
              />
            </Reveal>
            <Reveal height={340}>
              <DistributionCard dist={data.dist} />
            </Reveal>
          </div>
          <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
            <Reveal height={320}>
              <TopVideosCard posts={data.inRange} lookup={lookup} />
            </Reveal>
            <Reveal height={320}>
              <RecentPostsCard posts={data.posts} lookup={lookup} />
            </Reveal>
          </div>
      </>
    </section>
  );
}

/** The analytics range in the URL (`?range=`, `?from=`, `?to=`); the UGC Overview and Personal Brand share it. */
export function useRange(today: string) {
  const [rangeParam, setRange] = useQueryParam("range");
  const [fromParam, setFrom] = useQueryParam("from");
  const [toParam, setTo] = useQueryParam("to");
  const range: RangeKey = isRangeKey(rangeParam) ? rangeParam : "all";
  const pick = (v: string) => {
    if (!isRangeKey(v)) return;
    if (v === "custom") setRange("custom", { from: fromParam ?? today, to: toParam ?? today });
    else setRange(v === "all" ? null : v, { from: null, to: null });
  };
  return { range, fromParam, toParam, pick, setFrom, setTo };
}

/** The section title, its info dot, the custom days and the range picker. */
export function RangeBar({ range: r, title, children }: { range: ReturnType<typeof useRange>; title: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 pt-3">
      <Label className="text-body font-medium text-ink">{title}</Label>
      <InfoDot>{children}</InfoDot>
      <div className="flex-1" />
      {r.range === "custom" && (
        <div className="flex items-center gap-2">
          <DatePicker aria-label="From" value={r.fromParam ?? ""} max={r.toParam ?? undefined} rangeEnd={r.toParam} onChange={(e) => r.setFrom(e.target.value || null)} className="h-8 w-[150px]" />
          <span className="text-label text-ink-3">to</span>
          <DatePicker aria-label="To" value={r.toParam ?? ""} min={r.fromParam ?? undefined} rangeStart={r.fromParam} onChange={(e) => r.setTo(e.target.value || null)} className="h-8 w-[150px]" />
        </div>
      )}
      <Seg
        aria-label={`${title} range`}
        items={RANGE_KEYS.map((k) => ({ value: k, label: RANGE_LABEL[k] }))}
        value={r.range}
        onValueChange={r.pick}
        className="max-sm:w-full"
      />
    </div>
  );
}

export function PickDays() {
  return (
    <Card>
      <p className="py-10 text-center text-label text-ink-3">Pick a start and an end day</p>
    </Card>
  );
}

export function Empty({ children }: { children: string }) {
  return <p className="py-10 text-center text-label text-ink-3">{children}</p>;
}

function ViewsByDealCard({ data }: { data: ReturnType<typeof viewsByDeal> }) {
  const total = data.days.reduce((s, d) => s + d.values.reduce((a, b) => a + b, 0), 0);
  return (
    <Card aria-label="Views by deal">
      <SectionLabel aside={<InfoDot>Each post&apos;s views on the day it was posted. A period longer than a year shows its last 366 days.</InfoDot>}>Views by deal</SectionLabel>
      {data.deals.length === 0 ? (
        <Empty>No posts in this range</Empty>
      ) : (
        <>
          <span className="text-figure-s tabular-nums">{total.toLocaleString("en-US")}</span>
          <ViewsLines data={data} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-tag text-ink-2">
            {data.deals.map((d, i) => (
              <span key={d.id} className="flex items-center gap-1.5">
                <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: RAMP[i % RAMP.length] }} />
                {d.name}
              </span>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

export function ConsistencyCard({ year }: { year: ReturnType<typeof consistency> }) {
  return (
    <Card aria-label="Posting consistency">
      <SectionLabel
        aside={
          <>
            <Pill tone="strong">{`Streak ${plural(year.currentStreak, "day")}`}</Pill>
            <Pill>{`Longest ${plural(year.longestStreak, "day")}`}</Pill>
            <InfoDot>Last 365 days. A square is darker the more platforms you posted on that day. A streak counts days with a post, back from yesterday while today is still open.</InfoDot>
          </>
        }
      >
        Posting consistency
      </SectionLabel>
      <YearHeatmap days={year.days} />
    </Card>
  );
}

function Delta({ series }: { series: readonly number[] }) {
  const d = splitSeriesDelta(series);
  if (d.deltaPct === null) return null;
  return (
    <Pill tone="soft" className="tabular-nums">
      {`${d.deltaPct > 0 ? "+" : d.deltaPct < 0 ? "−" : ""}${Math.abs(d.deltaPct)}%`}
    </Pill>
  );
}

export function Tile({
  label,
  value,
  series,
  info,
  aside,
}: {
  label: string;
  value: React.ReactNode;
  series?: readonly number[];
  info?: string;
  /** Beside the figure, in place of the half-over-half change. */
  aside?: ReactNode;
}) {
  return (
    <div data-slot="analytics-tile" className="relative flex min-w-0 flex-col gap-2 bg-surface p-6 max-md:p-4">
      <Label className={info ? "pr-6" : undefined}>{label}</Label>
      <div className="flex items-baseline gap-2.5">
        <span className="text-figure-s tabular-nums">{value}</span>
        {aside ?? (series && <Delta series={series} />)}
      </div>
      {series ? <Sparkline data={series} height={28} label={`${label} per day`} /> : <span aria-hidden className="h-7" />}
      {info && <InfoDot className="absolute top-4 right-4 max-md:top-3 max-md:right-3">{info}</InfoDot>}
    </div>
  );
}

function EngagementCard({ totals, views, earnings }: { totals: ReturnType<typeof engagementTotals>; views: number[]; earnings: number[] }) {
  const earned = earnings.reduce((a, b) => a + b, 0);
  const unread = totals.unread > 0 ? `${plural(totals.unread, "post")} in this range have no likes or comments reading yet.` : undefined;
  return (
    <Strip cols={2} role="region" aria-label="Engagement" className="h-full">
      <Tile label="Views" value={compact(totals.views)} series={views} info="Views of the posts made in this range. The figure beside it compares the second half of the range with the first." />
      <Tile label="Likes" value={compact(totals.likes)} info={unread} />
      <Tile label="Comments" value={compact(totals.comments)} info={unread} />
      <Tile label="Earnings" value={<Money cents={earned} whole />} series={earnings} info="What the videos posted in this range earn, from the ledger." />
    </Strip>
  );
}

function EarningsCard({ series }: { series: { day: string; cents: number }[] }) {
  const total = series.reduce((s, p) => s + p.cents, 0);
  return (
    <Card aria-label="Earnings over time" className="h-full">
      <SectionLabel aside={<InfoDot>Earned per posting day. A video on several accounts pays once.</InfoDot>}>Earnings over time</SectionLabel>
      {total === 0 ? (
        <Empty>No earnings in this range</Empty>
      ) : (
        <>
          <span className="text-figure-s tabular-nums">
            <Money cents={total} whole />
          </span>
          <TrendLine data={series.map((p) => ({ label: shortDay(p.day), value: p.cents }))} height={150} label="Earnings over time" />
          <div className="flex justify-between text-tag text-ink-3">
            <span>{shortDay(series[0].day)}</span>
            <span>{shortDay(series[series.length - 1].day)}</span>
          </div>
        </>
      )}
    </Card>
  );
}

function PlatformCard({
  title,
  unit,
  mix,
  calendar,
  format,
  today,
}: {
  title: string;
  unit: string;
  mix: { slices: PlatformSlice[]; total: number };
  calendar: { day: string; value: number }[];
  format: (n: number) => string;
  today: string;
}) {
  const [view, setView] = useState("chart");
  const slices = mix.slices.filter((s) => s.value > 0);
  return (
    <Card aria-label={title} className="h-full">
      <SectionLabel
        aside={
          <Seg
            aria-label={`${title} view`}
            items={[
              { value: "chart", label: "Chart" },
              { value: "calendar", label: "Calendar" },
            ]}
            value={view}
            onValueChange={setView}
          />
        }
      >
        {title}
      </SectionLabel>
      {slices.length === 0 ? (
        <Empty>{`No ${unit} in this range`}</Empty>
      ) : view === "calendar" ? (
        <MonthSeries series={calendar} format={format} unit={unit} defaultMonth={today.slice(0, 7)} />
      ) : (
        <>
          <div className="relative py-2">
            <Donut data={slices.map((s) => ({ label: PLATFORM_LABEL[s.platform], value: s.value }))} size={150} label={title} />
            <span className="pointer-events-none absolute inset-0 grid place-items-center text-body font-medium tabular-nums">{format(mix.total)}</span>
          </div>
          <div>
            {slices.map((s, i) => (
              <ListRow key={s.platform} className="py-2">
                <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: RAMP[i % RAMP.length] }} />
                <span className="flex-1">{PLATFORM_LABEL[s.platform]}</span>
                <span className="text-ink-3 tabular-nums">{s.pct}%</span>
                <span className="w-14 text-right tabular-nums">{format(s.value)}</span>
              </ListRow>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

export function DistributionCard({ dist }: { dist: ReturnType<typeof viewDistribution> }) {
  const empty = dist.every((b) => b.count === 0);
  return (
    <Card aria-label="View distribution" className="h-full">
      <SectionLabel aside={<InfoDot>Posts in this range, grouped by their view count.</InfoDot>}>View distribution</SectionLabel>
      {empty ? (
        <Empty>No posts in this range</Empty>
      ) : (
        <Bars data={dist.map((b) => ({ label: b.label.replace(/-.*$/, "+"), values: [b.count] }))} series={["Posts"]} height={240} label="Posts by view count" />
      )}
    </Card>
  );
}

export type PostInfo = { title: string; url: string | null; meta: string };

function usePostLookup(): (p: AnalyticsPost) => PostInfo {
  const { raw, model } = useUgc();
  return useMemo(() => {
    const post = new Map(raw.posts.map((p) => [p.id, p]));
    const deal = new Map(model.deals.map((d) => [d.deal.id, d.deal.brand_name]));
    const handle = new Map(raw.accounts.map((a) => [a.id, a.handle]));
    return (p: AnalyticsPost) => {
      const r = post.get(p.id);
      return {
        title: r?.title?.trim() || (r ? displayUrl(r.url) : p.id),
        url: r?.url ?? null,
        meta: [deal.get(p.dealId), PLATFORM_LABEL[p.platform], r?.account_id ? `@${handle.get(r.account_id) ?? ""}` : null, shortDay(dayKeyInZone(new Date(p.postedAt), model.zone))].filter(Boolean).join(" · "),
      };
    };
  }, [raw, model]);
}

function PostRow({ p, rank, info }: { p: AnalyticsPost; rank?: number; info: PostInfo }) {
  const title = <span className="block truncate">{info.title}</span>;
  return (
    <ListRow data-post={p.id}>
      {rank !== undefined && <span className="w-5 shrink-0 text-tag text-ink-3 tabular-nums">{rank}</span>}
      <div className="min-w-0 flex-1">
        {info.url ? (
          <a href={info.url} target="_blank" rel="noreferrer noopener" className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
            {title}
          </a>
        ) : (
          title
        )}
        <span className="block truncate text-tag text-ink-3">{info.meta}</span>
      </div>
      <span className="shrink-0 tabular-nums">{p.views > 0 ? compact(p.views) : "—"}</span>
    </ListRow>
  );
}

export function More({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null;
  return (
    <Button variant="ghost" className="self-start" onClick={onMore}>
      Show more
    </Button>
  );
}

export function TopVideosCard({
  posts,
  lookup,
  title = "Top videos",
  empty = "No videos in this range",
}: {
  posts: readonly AnalyticsPost[];
  lookup: (p: AnalyticsPost) => PostInfo;
  title?: string;
  empty?: string;
}) {
  const [sort, setSort] = useState<"views" | "recent">("views");
  const [limit, setLimit] = useState(TOP_VIDEOS_PAGE);
  const ranked = useMemo(() => topVideos(posts, sort), [posts, sort]);
  return (
    <Card aria-label={title}>
      <SectionLabel
        aside={
          <Seg
            aria-label={`Sort ${title.toLowerCase()}`}
            items={[
              { value: "views", label: "Views" },
              { value: "recent", label: "Recent" },
            ]}
            value={sort}
            onValueChange={(v) => {
              setSort(v === "recent" ? "recent" : "views");
              setLimit(TOP_VIDEOS_PAGE);
            }}
          />
        }
      >
        {`${title}${ranked.length ? ` (${ranked.length})` : ""}`}
      </SectionLabel>
      {ranked.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <div>
          {ranked.slice(0, limit).map((p, i) => (
            <PostRow key={p.id} p={p} rank={i + 1} info={lookup(p)} />
          ))}
        </div>
      )}
      <More shown={limit} total={ranked.length} onMore={() => setLimit((l) => l + TOP_VIDEOS_PAGE)} />
    </Card>
  );
}

function RecentPostsCard({ posts, lookup }: { posts: readonly AnalyticsPost[]; lookup: (p: AnalyticsPost) => PostInfo }) {
  const [limit, setLimit] = useState(LATEST_POSTS_PAGE);
  const list = useMemo(() => latestPosts(posts), [posts]);
  return (
    <Card aria-label="Recent posts">
      <SectionLabel>{`Recent posts${list.length ? ` (${list.length})` : ""}`}</SectionLabel>
      {list.length === 0 ? (
        <Empty>No posts yet</Empty>
      ) : (
        <div>
          {list.slice(0, limit).map((p) => (
            <PostRow key={p.id} p={p} info={lookup(p)} />
          ))}
        </div>
      )}
      <More shown={limit} total={list.length} onMore={() => setLimit((l) => l + LATEST_POSTS_PAGE)} />
    </Card>
  );
}
