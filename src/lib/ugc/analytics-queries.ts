// No `import "server-only"`: vitest cannot resolve that bare id (see writes.ts). Its callers
// (src/app/(app)/ugc/data.ts, src/lib/brand/queries.ts) are server-only.
import type { EngagementRow } from "@/lib/ugc/analytics";
import type { Db } from "@/lib/ugc/writes";

const PAGE = 1000;

type Reading = { likes: number | string | null; comments: number | string | null };

/**
 * The latest trusted (not held) likes and comments of each post, read as the signed-in owner (RLS).
 * One row per post: PostgREST embeds each post's newest reading that carries likes or comments
 * (a lateral join on the (post_id, captured_day) key), so the cost follows the posts, not the history.
 * A post with no such reading has no row.
 */
export async function readLatestEngagement(db: Db, dealIds?: readonly string[]): Promise<EngagementRow[]> {
  const out: EngagementRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = db.from("posts").select("id, post_view_snapshots(likes, comments)");
    // Only these deals' posts (the Personal Brand page reads its own).
    if (dealIds) q = q.in("deal_id", [...dealIds]);
    const { data, error } = await q
      .eq("post_view_snapshots.held", false)
      .or("likes.not.is.null,comments.not.is.null", { referencedTable: "post_view_snapshots" })
      .order("captured_day", { referencedTable: "post_view_snapshots", ascending: false })
      .limit(1, { referencedTable: "post_view_snapshots" })
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`UGC read failed: ${error.message}`);
    const rows = (data ?? []) as { id: string; post_view_snapshots: Reading[] | null }[];
    for (const r of rows) {
      const latest = r.post_view_snapshots?.[0];
      if (!latest) continue;
      out.push({
        post_id: r.id,
        likes: latest.likes === null ? null : Number(latest.likes),
        comments: latest.comments === null ? null : Number(latest.comments),
      });
    }
    if (rows.length < PAGE) return out;
  }
}
