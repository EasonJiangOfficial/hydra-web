"use client";

import { useMemo } from "react";

import { offerUndo } from "@/components/activity/undo-bar";
import { Button, Card, InfoDot, Label, ListRow, Pill, cn } from "@/components/kit";
import { dayKeyInZone } from "@/lib/ugc/days";
import { formatViewCount } from "@/lib/ugc/format-views";

import { ErrorText, useAct } from "./controls";
import { apart, shortDay, type NeedsMatchView, type TwinView, type VideoPost, type VideoView } from "./model";
import { useUgc } from "./store";

export const PLATFORM = { TIKTOK: "TikTok", INSTAGRAM: "Reels", YOUTUBE: "Shorts", FACEBOOK: "Facebook" } as const;

/** Why the matcher thinks two posts are one video, in a few words. */
export function reasonText(t: Pick<TwinView, "reason" | "gapMs">): string {
  return `${t.reason === "title" ? "Same caption" : "Posted together"} · ${apart(t.gapMs)}`;
}

const where = (p: VideoPost) => (p.handle ? `${PLATFORM[p.platform]} · @${p.handle}` : PLATFORM[p.platform]);
const quote = (title: string) => `"${title.length > 40 ? `${title.slice(0, 39)}…` : title}"`;

function PostLine({ post, className }: { post: VideoPost; className?: string }) {
  const { model } = useUgc();
  const day = dayKeyInZone(new Date(post.postedAt), model.zone);
  return (
    <span className={cn("flex min-w-0 flex-col", className)}>
      {post.url.startsWith("https://") ? (
        <a href={post.url} target="_blank" rel="noopener noreferrer" className="truncate underline-offset-2 hover:underline">
          {post.title}
        </a>
      ) : (
        <span className="truncate">{post.title}</span>
      )}
      <span className="truncate text-tag text-ink-3">{`${where(post)} · ${shortDay(day)} · ${formatViewCount(post.views)}`}</span>
    </span>
  );
}

/**
 * Unlinked posts that look like another platform's post of the same video (the matcher's scored
 * candidates, held ones included). One click links a twin; "Keep apart" unlinks it by hand so it is not
 * suggested again. Both show the undo bar. Hidden when nothing needs matching.
 */
export function NeedsMatching({ dealId }: { dealId: string | null }) {
  const { model } = useUgc();
  const items = useMemo(() => model.needsMatching.filter((n) => !dealId || n.dealId === dealId), [model.needsMatching, dealId]);
  if (items.length === 0) return null;
  return (
    <Card aria-label="Needs matching" data-testid="needs-matching">
      <div className="flex items-center gap-2">
        <Label>Needs matching</Label>
        <span className="text-label text-ink-3 tabular-nums">{items.length}</span>
        <InfoDot label="About matching">
          One video on several platforms is paid once: on its most-viewed platform, or on all its views added together when the
          deal combines platforms. Link a post to its twin, or keep it apart.
        </InfoDot>
      </div>
      <div className="flex flex-col">
        {items.map((n) => (
          <NeedsRow key={n.post.id} item={n} showDeal={!dealId} />
        ))}
      </div>
    </Card>
  );
}

function NeedsRow({ item, showDeal }: { item: NeedsMatchView; showDeal: boolean }) {
  const { actions } = useUgc();
  const { busy, error, act } = useAct();
  const link = (twin: TwinView) =>
    act(async () => {
      const r = await actions.linkPosts({ postIds: [item.post.id, twin.post.id] });
      if (r.ok) {
        const platforms = [...new Set([item.post.platform, twin.post.platform])].map((p) => PLATFORM[p]).join(" and ");
        // Platforms first: on a phone the bar cuts the end, and the title is already on the page.
        offerUndo(r.activityId, `${platforms} for ${quote(item.post.title)}`, undefined, "Linked");
      }
      return r;
    });
  const keepApart = () =>
    act(async () => {
      const r = await actions.unlinkPost({ postId: item.post.id });
      if (r.ok) offerUndo(r.activityId, `${quote(item.post.title)} apart`, undefined, "Kept");
      return r;
    });

  return (
    <ListRow as="div" data-needs={item.post.id} className="flex-col items-stretch gap-2 md:flex-row md:items-start md:gap-4">
      <div className="flex min-w-0 flex-col items-start md:w-[38%] md:flex-none">
        <PostLine post={item.post} className="w-full" />
        {showDeal && <span className="text-tag text-ink-3">{item.brandName}</span>}
        <Button
          variant="ghost"
          className="-ml-2 h-7 px-2 text-tag text-ink-3 hover:text-ink max-md:h-10"
          disabled={busy}
          aria-label={`Keep ${item.post.title} apart`}
          onClick={() => void keepApart()}
        >
          Keep apart
        </Button>
      </div>
      <ul
        className="flex min-w-0 flex-1 flex-col gap-2 max-md:border-l max-md:border-rule-2 max-md:pl-3"
        aria-label={`Twins of ${item.post.title}`}
      >
        {item.twins.map((t) => (
          <li key={t.post.id} className="flex min-w-0 items-center gap-3">
            <span className="flex min-w-0 flex-1 flex-col">
              <PostLine post={t.post} />
              <Why twin={t} className="md:hidden" />
            </span>
            <Why twin={t} className="flex-none flex-col items-end gap-0.5 text-right max-md:hidden" />
            <Button
              className="h-7 flex-none px-2.5 text-tag max-md:h-10 max-md:px-3"
              variant="outline"
              disabled={busy}
              aria-label={`Link ${item.post.title} on ${PLATFORM[item.post.platform]} with ${t.post.title} on ${PLATFORM[t.post.platform]}`}
              onClick={() => void link(t)}
            >
              Link
            </Button>
          </li>
        ))}
        {error && (
          <li>
            <ErrorText>{error}</ErrorText>
          </li>
        )}
      </ul>
    </ListRow>
  );
}

/** The reason line: "Same caption · 12 min apart", plus "Video on 3" and "Held" when they apply. */
function Why({ twin: t, className }: { twin: TwinView; className?: string }) {
  return (
    <span className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5", className)}>
      <span className="text-tag whitespace-nowrap text-ink-2">{reasonText(t)}</span>
      {(t.videoSize > 1 || t.zeroes) && (
        <span className="flex items-center gap-1.5">
          {t.videoSize > 1 && <Pill tone="soft">{`Video on ${t.videoSize}`}</Pill>}
          {t.zeroes && (
            <>
              <Pill tone="soft">Held</Pill>
              <InfoDot label="Why it is held" className="size-4 text-[10px]">
                A post of this video is excluded or priced $0. Linking pays this video $0.
              </InfoDot>
            </>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * A linked video's platform posts: views each, which ones it is paid on ("Paid" on the most views; "Counted"
 * on each under "Combine platforms"; none when excluded), and Unlink.
 */
export function VideoPosts({ video, id }: { video: VideoView; id: string }) {
  return (
    <ul id={id} aria-label={`Platforms of ${video.title}`} className="flex flex-col motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200">
      {video.posts.map((p) => (
        <VideoPostRow key={p.id} post={p} video={video} />
      ))}
    </ul>
  );
}

function VideoPostRow({ post, video }: { post: VideoPost; video: VideoView }) {
  const { actions } = useUgc();
  const { busy, error, act } = useAct();
  return (
    <ListRow as="li" data-post={post.id} className="gap-3 py-2">
      <span className="flex min-w-0 flex-1 flex-col">
        {post.url.startsWith("https://") ? (
          <a href={post.url} target="_blank" rel="noopener noreferrer" className="truncate underline-offset-2 hover:underline">
            {where(post)}
          </a>
        ) : (
          <span className="truncate">{where(post)}</span>
        )}
        <ErrorText>{error}</ErrorText>
      </span>
      <span className="w-[72px] flex-none text-right tabular-nums">{formatViewCount(post.views)}</span>
      <span className={cn("flex-none", video.combined ? "w-[64px]" : "w-[36px]")}>{post.paid && <Pill>{video.combined ? "Counted" : "Paid"}</Pill>}</span>
      <Button
        variant="ghost"
        className="h-7 flex-none px-2 text-tag text-ink-3 hover:text-ink max-md:h-10"
        disabled={busy}
        aria-label={`Unlink ${PLATFORM[post.platform]} from ${video.title}`}
        onClick={() =>
          void act(async () => {
            const r = await actions.unlinkPost({ postId: post.id });
            if (r.ok) offerUndo(r.activityId, `${PLATFORM[post.platform]} from ${quote(video.title)}`, undefined, "Unlinked");
            return r;
          })
        }
      >
        Unlink
      </Button>
    </ListRow>
  );
}
