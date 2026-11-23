"use client";

import { Eye, Heart, MessageCircle } from "lucide-react";
import { useMemo, useState, useTransition } from "react";

import { Button, Card, Input, Pill, Strip } from "@/components/kit";
import { PageHeader } from "@/components/shell/page-header";
import { SectionLabel } from "@/components/ugc/controls";
import {
  ConsistencyCard,
  DistributionCard,
  Empty,
  More,
  PickDays,
  RangeBar,
  Tile,
  TopVideosCard,
  plural,
  useRange,
  type PostInfo,
} from "@/components/ugc/analytics";
import { Reveal, ViewsLines, compact } from "@/components/ugc/analytics/charts";
import { displayUrl, shortDay } from "@/components/ugc/model";
import { brandPosts, engagementRate, followerStats, postsPerWeek, type BrandRaw } from "@/lib/brand/model";
import {
  consistency,
  engagementTotals,
  inWindow,
  latestPosts,
  resolveWindow,
  trendDays,
  viewDistribution,
  viewsPerDay,
  type AnalyticsPost,
} from "@/lib/ugc/analytics";
import type { InstagramView } from "@/lib/instagram/model";
import { dayKeyInZone } from "@/lib/ugc/days";
import type { ActionResult } from "@/lib/ugc/schemas";

import { InstagramControl, useInstagramNote, type SyncInstagram } from "./instagram-control";

export type SaveFollowers = (input: { followers: number }) => Promise<ActionResult<unknown>>;
export type { SyncInstagram };

const GRID_PAGE = 12;
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${compact(Math.abs(n))}`;

/**
 * Personal Brand: the owner's own Instagram. Followers over time, the posts' views, likes, comments and
 * engagement, posting consistency, top posts and a grid of the posts. The blocks are the UGC Overview's. The
 * header carries the Instagram connection (Connect, Sync now, Reconnect).
 */
export function BrandPage({
  raw,
  saveFollowers,
  instagram,
  syncInstagram,
}: {
  raw: BrandRaw;
  saveFollowers: SaveFollowers;
  instagram: InstagramView;
  syncInstagram: SyncInstagram;
}) {
  const now = useMemo(() => new Date(raw.nowIso), [raw.nowIso]);
  const today = dayKeyInZone(now, raw.zone);
  const r = useRange(today);
  const { range, fromParam, toParam } = r;
  const ig = useInstagramNote();

  const data = useMemo(() => {
    const zone = raw.zone;
    const posts = brandPosts(raw);
    const win = resolveWindow(range, { now, zone, customStart: fromParam, customEnd: toParam });
    if (!win) return { win: null } as const;
    const inRange = inWindow(posts, win);
    const days = trendDays(win, posts, zone);
    const totals = engagementTotals(inRange);
    return {
      win,
      inRange,
      totals,
      rate: engagementRate(inRange),
      perWeek: postsPerWeek(inRange.length, win, posts),
      views: viewsPerDay(inRange, days, zone).map((p) => p.total),
      followers: followerStats(raw.followers, win, zone),
      year: consistency(posts, now, zone),
      dist: viewDistribution(inRange),
      grid: latestPosts(inRange),
    };
  }, [raw, now, range, fromParam, toParam]);

  const lookup = useMemo(() => {
    const post = new Map(raw.posts.map((p) => [p.id, p]));
    return (p: AnalyticsPost): PostInfo => {
      const row = post.get(p.id);
      const likes = p.likes === null ? null : `${compact(p.likes)} likes`;
      return {
        title: row?.title?.trim() || (row ? displayUrl(row.url) : p.id),
        url: row?.url ?? null,
        meta: [shortDay(dayKeyInZone(new Date(p.postedAt), raw.zone)), likes].filter(Boolean).join(" · "),
      };
    };
  }, [raw]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Personal Brand" actions={<InstagramControl view={instagram} now={raw.nowIso} sync={syncInstagram} setError={ig.setError} />} />
      {/* Under the header, not in its row: on phone the row has no room for a sentence. */}
      {ig.note && (
        <p role="alert" className="-mt-3 text-tag text-ink-2">
          {ig.note}
        </p>
      )}
      {/* Connected, the desktop header shows the handle: the bar does not repeat it there. The phone header hides it, so the bar keeps it. */}
      <RangeBar
        range={r}
        title={
          instagram.username ? (
            <>
              <span className="sm:hidden">@{instagram.username}</span>
              <span className="max-sm:hidden">Instagram</span>
            </>
          ) : raw.handle ? (
            `@${raw.handle}`
          ) : (
            "Instagram"
          )
        }
      >
        Your own Instagram, kept apart from UGC deals. Views, likes and comments are each post&apos;s latest reading. The range filters every block but posting consistency.
      </RangeBar>

      {!data.win ? (
        <PickDays />
      ) : (
        <>
          <Strip cols={4} role="region" aria-label="Account" className="lg:grid-cols-6">
            <Tile
              label="Followers"
              value={data.followers.latest ? compact(data.followers.latest.followers) : "—"}
              aside={data.followers.change !== null && <Pill tone="soft" className="tabular-nums">{signed(data.followers.change)}</Pill>}
              info={
                data.followers.latest
                  ? `Last count ${shortDay(data.followers.latest.day)} (${data.followers.latest.source === "manual" ? "typed" : "synced"}). The figure beside it is the change in this range.`
                  : "No count yet. Type one under Followers, or connect Instagram."
              }
            />
            <Tile label="Views" value={compact(data.totals.views)} series={data.views} info="Views of the posts made in this range. The figure beside it compares the second half of the range with the first." />
            <Tile label="Likes" value={compact(data.totals.likes)} info={unreadInfo(data.totals.unread)} />
            <Tile label="Comments" value={compact(data.totals.comments)} info={unreadInfo(data.totals.unread)} />
            <Tile
              label="Engagement"
              value={data.rate === null ? "—" : `${(data.rate * 100).toFixed(data.rate < 0.1 ? 1 : 0)}%`}
              info="Likes plus comments, divided by views, over the posts in this range that have a likes or comments reading."
            />
            <Tile
              label="Posts"
              value={data.inRange.length.toLocaleString("en-US")}
              aside={data.inRange.length > 0 && <span className="text-tag text-ink-3 tabular-nums">{`${data.perWeek.toFixed(1)} / week`}</span>}
              info="Posts made in this range, and the average per week."
            />
          </Strip>

          <Reveal height={280}>
            <FollowersCard stats={data.followers} today={today} save={saveFollowers} />
          </Reveal>
          <Reveal height={220}>
            <ConsistencyCard year={data.year} />
          </Reveal>
          <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
            <Reveal height={320}>
              <TopVideosCard posts={data.inRange} lookup={lookup} title="Top posts" empty="No posts in this range" />
            </Reveal>
            <Reveal height={320}>
              <DistributionCard dist={data.dist} />
            </Reveal>
          </div>
          <Reveal height={360}>
            <PostGrid posts={data.grid} raw={raw} />
          </Reveal>
        </>
      )}
    </div>
  );
}

function unreadInfo(unread: number): string | undefined {
  return unread > 0 ? `${plural(unread, "post")} in this range have no likes or comments reading yet.` : undefined;
}

function FollowersCard({ stats, today, save }: { stats: ReturnType<typeof followerStats>; today: string; save: SaveFollowers }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const n = Number(value.replace(/[,\s]/g, ""));
  const valid = value.trim() !== "" && Number.isInteger(n) && n >= 0;
  const submit = () =>
    start(async () => {
      // The server picks the day (owner zone), so a tab left open past midnight saves today, not yesterday.
      const res = await save({ followers: n });
      if (res.ok) {
        setValue("");
        setError(null);
      } else setError(res.error.message);
    });
  const chart = { deals: [{ id: "followers", name: "Followers" }], days: stats.points.map((p) => ({ day: p.day, values: [p.followers] })) };
  return (
    <Card aria-label="Followers">
      <SectionLabel
        aside={
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid && !pending) submit();
            }}
          >
            <Input
              inputMode="numeric"
              aria-label={`Followers on ${shortDay(today)}`}
              placeholder="Today's count"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-8 w-[140px] tabular-nums"
            />
            <Button type="submit" variant="primary" className="h-8" disabled={!valid || pending}>
              Save
            </Button>
          </form>
        }
      >
        Followers
      </SectionLabel>
      {error && (
        <p role="alert" className="text-tag text-ink-2">
          {error}
        </p>
      )}
      {stats.points.length < 2 ? (
        <Empty>{stats.points.length === 1 ? "One count so far" : "No follower counts in this range"}</Empty>
      ) : (
        <ViewsLines data={chart} height={200} fit label="Followers over time" />
      )}
    </Card>
  );
}

function PostGrid({ posts, raw }: { posts: readonly AnalyticsPost[]; raw: BrandRaw }) {
  const [limit, setLimit] = useState(GRID_PAGE);
  const url = useMemo(() => new Map(raw.posts.map((p) => [p.id, p.url])), [raw.posts]);
  return (
    <Card aria-label="Posts">
      <SectionLabel>{`Posts${posts.length ? ` (${posts.length})` : ""}`}</SectionLabel>
      {posts.length === 0 ? (
        <Empty>No posts in this range</Empty>
      ) : (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6 max-sm:gap-2">
          {posts.slice(0, limit).map((p) => (
            <PostTile key={p.id} p={p} href={url.get(p.id) ?? null} thumb={raw.thumbs[p.id] ?? null} zone={raw.zone} />
          ))}
        </ul>
      )}
      <More shown={limit} total={posts.length} onMore={() => setLimit((l) => l + GRID_PAGE)} />
    </Card>
  );
}

function PostTile({ p, href, thumb, zone }: { p: AnalyticsPost; href: string | null; thumb: string | null; zone: string }) {
  const day = shortDay(dayKeyInZone(new Date(p.postedAt), zone));
  const stat = (n: number | null) => (n === null ? "—" : compact(n));
  const label = `${day}: ${p.views.toLocaleString("en-US")} views, ${p.likes ?? "no"} likes, ${p.comments ?? "no"} comments`;
  const face = (
    <span className="relative block aspect-square overflow-hidden rounded-lg bg-tint">
      {thumb ? (
        // eslint-disable-next-line @next/next/no-img-element -- an Instagram CDN link (CSP img-src), not an optimizable asset
        <img src={thumb} alt="" loading="lazy" className="size-full object-cover transition-opacity duration-200 group-hover:opacity-85" />
      ) : (
        <span aria-hidden className="grid size-full place-items-center text-tag text-ink-3 transition-colors duration-200 group-hover:bg-hover">
          {day}
        </span>
      )}
    </span>
  );
  return (
    <li data-post={p.id} className="flex min-w-0 flex-col gap-1.5">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={label}
          className="group rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          {face}
        </a>
      ) : (
        <span aria-label={label}>{face}</span>
      )}
      <span aria-hidden className="flex items-center gap-2 text-tag text-ink-3 tabular-nums max-sm:gap-1.5">
        <span className="flex items-center gap-1 text-ink-2">
          <Eye className="size-3" strokeWidth={1.5} />
          {p.views > 0 ? compact(p.views) : "—"}
        </span>
        <span className="flex items-center gap-1">
          <Heart className="size-3" strokeWidth={1.5} />
          {stat(p.likes)}
        </span>
        <span className="flex items-center gap-1 max-sm:hidden">
          <MessageCircle className="size-3" strokeWidth={1.5} />
          {stat(p.comments)}
        </span>
      </span>
    </li>
  );
}
