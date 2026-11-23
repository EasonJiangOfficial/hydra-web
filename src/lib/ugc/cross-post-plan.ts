/**
 * The cross-post backfill plan (scripts/ugc-link): per deal, which unlinked
 * posts the matcher links and what the deal earns before and after, priced by
 * the real ledger (dealEarnings) on the database's rows. Pure.
 *
 * A grouped video is paid at its most-viewed member's rate (Ripple's best-row
 * rule; a member with no snapshot takes the deal's CURRENT rate). So a link
 * can reprice a video, not only dedupe it. The plan names those mixed-rate
 * videos and splits the earned change into the part from them and the rest.
 */
import { dealEarnings, dealFallbackRate, postRateSnapshot, type DealRow, type PostRow } from "@/lib/ugc/ledger";
import { applyLinks, matchCrossPostsDetailed, type GroupLink, type HeldLink, type MatchPost } from "@/lib/ugc/match";
import { resolveRowRate } from "@/lib/ugc/pay-aggregate";

export type PlanPost = PostRow & MatchPost;

export interface PlanGroup {
  groupId: string;
  /** True when members carry different pay rates: the video is paid at the most-viewed member's. */
  mixedRates: boolean;
  posts: {
    id: string;
    platform: string;
    title: string | null;
    posted_at: string;
    views: number | null;
    /** This post's base pay per video in cents (its snapshot, else the deal's current rate). */
    baseCents: number;
    moved: boolean;
  }[];
}

export interface DealPlan {
  dealId: string;
  brand: string;
  posts: number;
  groupsBefore: number;
  groupsAfter: number;
  postsLinked: number;
  earnedBeforeCents: number;
  earnedAfterCents: number;
  /** Part of the earned change from groups whose members carry different rates. */
  mixedRateDeltaCents: number;
  links: GroupLink[];
  /** Posts not linked because their twin's group has an excluded member or a $0 override: the owner decides. */
  held: HeldLink[];
  preview: PlanGroup[];
}

const videoCount = (posts: readonly PostRow[]) =>
  new Set(posts.map((p) => (p.video_group_id ? `g:${p.video_group_id}` : `p:${p.id}`))).size;

export function planCrossPosts(
  deals: readonly DealRow[],
  posts: readonly PlanPost[],
  zone: string,
  today: string,
): DealPlan[] {
  return deals.map((deal) => {
    const mine = posts.filter((p) => p.deal_id === deal.id);
    const { links, held } = matchCrossPostsDetailed(mine);
    const after = applyLinks(mine, links);
    const moved = new Set(links.map((l) => l.postId));
    const touched = [...new Set(links.map((l) => l.groupId))].sort();
    const fallback = dealFallbackRate(deal);
    const rateOf = (p: PlanPost) => resolveRowRate(postRateSnapshot(p), fallback);
    const preview: PlanGroup[] = touched.map((groupId) => {
      const members = after.filter((p) => p.video_group_id === groupId);
      return {
        groupId,
        mixedRates: new Set(members.map((p) => JSON.stringify(rateOf(p)))).size > 1,
        posts: members.map((p) => ({
          id: p.id,
          platform: p.platform,
          title: p.title,
          posted_at: p.posted_at,
          views: p.payable_views,
          baseCents: Math.round(rateOf(p).paymentPerVideo * 100),
          moved: moved.has(p.id),
        })),
      };
    });
    const mixed = new Set(preview.filter((g) => g.mixedRates).map((g) => g.groupId));
    const earnedBeforeCents = dealEarnings(deal, mine, zone, today).earnedCents;
    const mixedOnly = applyLinks(mine, links.filter((l) => mixed.has(l.groupId)));
    return {
      dealId: deal.id,
      brand: deal.brand_name,
      posts: mine.length,
      groupsBefore: videoCount(mine),
      groupsAfter: videoCount(after),
      postsLinked: links.length,
      earnedBeforeCents,
      earnedAfterCents: dealEarnings(deal, after, zone, today).earnedCents,
      mixedRateDeltaCents: dealEarnings(deal, mixedOnly, zone, today).earnedCents - earnedBeforeCents,
      links,
      held,
      preview,
    };
  });
}

const usd = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;

/** The dry-run text: one line per deal, then each new or grown group, then the held posts. */
export function formatPlan(plans: readonly DealPlan[], previewLimit = 20): string {
  const out: string[] = [];
  let before = 0;
  let after = 0;
  let mixedDelta = 0;
  for (const p of plans) {
    before += p.earnedBeforeCents;
    after += p.earnedAfterCents;
    mixedDelta += p.mixedRateDeltaCents;
    const delta = p.earnedAfterCents - p.earnedBeforeCents;
    const mixedCount = p.preview.filter((g) => g.mixedRates).length;
    out.push(
      `${p.brand} (${p.dealId}): posts ${p.posts}, videos ${p.groupsBefore} -> ${p.groupsAfter}, ` +
        `posts linked ${p.postsLinked}, earned ${usd(p.earnedBeforeCents)} -> ${usd(p.earnedAfterCents)} ` +
        `(${usd(delta)}: same-rate videos ${usd(delta - p.mixedRateDeltaCents)}, ` +
        `${mixedCount} mixed-rate videos ${usd(p.mixedRateDeltaCents)}), held ${p.held.length}`,
    );
    for (const g of p.preview.slice(0, previewLimit)) {
      out.push(`  ${g.groupId}${g.mixedRates ? "  MIXED RATES: paid at the most-viewed post's rate" : ""}`);
      for (const m of g.posts) {
        out.push(
          `    ${m.moved ? "+" : "="} ${m.platform.padEnd(9)} ${m.posted_at}  views ${m.views ?? "-"}  base ${usd(m.baseCents)}  ${JSON.stringify(m.title ?? "")}`,
        );
      }
    }
    if (p.preview.length > previewLimit) out.push(`  ... ${p.preview.length - previewLimit} more groups`);
    for (const h of p.held) out.push(`  HELD ${h.postId}: twin in ${h.groupId} (excluded or $0 override); link by hand if it is one video`);
  }
  out.push(
    `TOTAL earned ${usd(before)} -> ${usd(after)} (${usd(after - before)}: same-rate videos ${usd(after - before - mixedDelta)}, mixed-rate videos ${usd(mixedDelta)})`,
  );
  return out.join("\n");
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The --write SQL: every link in one transaction, written only where the post is still where the
 * plan saw it (no group, or its lone `auto-` group) and not set by hand; else nothing is written.
 */
export function writeSql(links: readonly { postId: string; groupId: string; from?: string }[]): string {
  const values = links
    .map((l) => `(${quote(l.postId)}::uuid, ${quote(l.groupId)}, ${l.from ? quote(l.from) : "null"})`)
    .join(",\n  ");
  return `begin;
create temp table link_plan (id uuid primary key, g text not null, f text) on commit drop;
insert into link_plan values
  ${values};
do $$
declare
  want int;
  n int;
begin
  select count(*) into want from link_plan;
  update public.posts p set video_group_id = l.g
  from link_plan l
  where p.id = l.id and p.video_group_id is not distinct from l.f and not p.video_group_manual;
  get diagnostics n = row_count;
  if n <> want then
    raise exception 'expected % links, could write % (rows changed since the read); nothing written', want, n;
  end if;
end;
$$;
commit;
`;
}
