/**
 * Cross-post matcher: which posts of ONE deal are the same video on other
 * platforms, so the ledger pays them once (DESIGN.md section 8). Pure.
 *
 * Ported from Ripple's lib/matching/caption-match.ts (matchByCaption). Ripple
 * linked two posts when caption OR thumbnail dHash OR a 10 minute posting gap
 * matched. Hydra has no thumbnails, so two signals, on different platforms only:
 *   - Title: same title within MATCH_WINDOW_MS. Word overlap (Jaccard) 0.5 counts
 *     within CLOSE_WINDOW_MS; further apart it must be FAR_JACCARD_MIN (a caption
 *     template like "<x> is the method" is not one video a day later).
 *   - Time: posted within NEAR_TIME_MS (Ripple's 10 minutes), any title. Creators
 *     post one clip with a different caption per platform. A time-only pair
 *     always ranks below every title pair.
 *
 *   - One post per platform per video; a video is at most 4 posts.
 *   - Only unlinked posts move: never a post the owner set by hand
 *     (video_group_manual), never one excluded or hand-priced. A post alone in
 *     an `auto-` group (a split left by two adds racing) counts as unlinked.
 *   - A post may join an existing group that lacks its platform, unless the
 *     owner linked that group by hand. A group with a priced override joins: the
 *     ledger pays the override once for the whole video. A group with an
 *     excluded member or a $0 override is HELD, not joined (joining would zero
 *     the post's pay; the owner may have zeroed the twin on purpose): see `held`.
 *   - Strongest pairs first (Ripple's phase 1/2), so a twin with the same title
 *     wins over a look-alike. Deterministic: same rows, same answer. Idempotent:
 *     linked posts leave the pool, so a rerun returns nothing new.
 */

/** Hard window between two posts of one video. Ripple has none; 36 h covers a next-day repost. */
export const MATCH_WINDOW_MS = 36 * 60 * 60 * 1000;

/** Within this gap a 0.5 word overlap is enough; beyond it the title must be nearly the same. */
export const CLOSE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Ripple's time signal (caption-match.ts TIME_WINDOW_MINUTES): other platform, any title. */
export const NEAR_TIME_MS = 10 * 60 * 1000;

/**
 * Word overlap (Jaccard) that counts as the same title. Ripple used 0.2 with a
 * thumbnail hash to back it up; with titles alone 0.2 merges template captions
 * ("3 apps that cure boredom" vs "3 apps for school" = 0.29), so 0.5.
 */
export const TITLE_JACCARD_MIN = 0.5;

/** Word overlap needed beyond CLOSE_WINDOW_MS ("ai is the method" vs "this is the method" = 0.6 fails). */
export const FAR_JACCARD_MIN = 0.8;

/** A shorter title whose words all appear in the longer one matches (a YouTube Short's cut title). */
export const SUBSET_MIN_TOKENS = 3;

export interface MatchPost {
  id: string;
  platform: string;
  title: string | null;
  posted_at: string;
  video_group_id: string | null;
  video_group_manual?: boolean | null;
  exclude_from_pay?: boolean | null;
  manual_override_cents?: number | string | null;
}

/** One post to move into a group (an existing group id or a new `auto-` id). */
export interface GroupLink {
  postId: string;
  groupId: string;
  /** Set when the post leaves a one-post `auto-` group; absent when it had none. */
  from?: string;
}

/** A post whose twin sits in a group the matcher may not join (excluded member or $0 override). */
export interface HeldLink {
  postId: string;
  groupId: string;
}

/** Ripple's normalizeCaption plus punctuation: lowercase, no emoji, no #tags, words only. */
export function normalizeTitle(title: string | null | undefined): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/#[\p{L}\p{N}_]+/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleTokens(title: string | null | undefined): string[] {
  const n = normalizeTitle(title);
  return n ? [...new Set(n.split(" "))] : [];
}

const isNumber = (t: string) => /^\p{N}+$/u.test(t);
const within = (small: readonly string[], big: readonly string[]) => small.every((t) => big.includes(t));

/**
 * How alike two titles are, 0 when they are not the same video. Ripple's
 * captionsMatch rules (exact, containment, word overlap), plus: different
 * numbers mean different videos ("worst classes pt 2" is not "pt 3"); one
 * title adding a number ("... in 2026") is not a difference.
 */
export function titleSimilarity(a: readonly string[], b: readonly string[], minJaccard = TITLE_JACCARD_MIN): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const numsA = a.filter(isNumber);
  const numsB = b.filter(isNumber);
  if (numsA.length && numsB.length && !within(numsA, numsB) && !within(numsB, numsA)) return 0;
  const shared = a.filter((t) => setB.has(t)).length;
  const jaccard = shared / (a.length + b.length - shared);
  const shorter = Math.min(a.length, b.length);
  const subset = shorter >= SUBSET_MIN_TOKENS && shared === shorter;
  return jaccard >= minJaccard || subset ? jaccard : 0;
}

interface Cluster {
  /** Existing group id; null for a new group being built. */
  groupId: string | null;
  platforms: Set<string>;
  /** Pool posts in this cluster (the ones that move). */
  moved: string[];
}

interface Edge {
  score: number;
  fixed: boolean;
  key: string;
  a: string;
  b: string; // a pool post id, or `g:<groupId>`
}

const dirty = (p: MatchPost) => Boolean(p.exclude_from_pay) || (p.manual_override_cents ?? null) !== null;
/** Joining would zero the video: an excluded member or a $0 override. */
const zeroes = (p: MatchPost) =>
  Boolean(p.exclude_from_pay) || (p.manual_override_cents != null && Number(p.manual_override_cents) === 0);

/** Why two posts look like one video: a title match, or posted within NEAR_TIME_MS. */
export type TwinReason = "title" | "time";

/** How alike two posts of one deal are: 0 when they are not one video. Title pairs always outrank time-only pairs. */
function pairScorer(posts: readonly MatchPost[], tokens: Map<string, string[]>) {
  const at = new Map(posts.map((p) => [p.id, Date.parse(p.posted_at)]));
  return (x: MatchPost, y: MatchPost): { score: number; reason: TwinReason; gapMs: number } => {
    const gap = Math.abs(at.get(x.id)! - at.get(y.id)!);
    if (x.platform === y.platform || !(gap <= MATCH_WINDOW_MS)) return { score: 0, reason: "time", gapMs: gap };
    const min = gap <= CLOSE_WINDOW_MS ? TITLE_JACCARD_MIN : FAR_JACCARD_MIN;
    const sim = titleSimilarity(tokens.get(x.id)!, tokens.get(y.id)!, min);
    // Title first (score above 0.5); closeness in time breaks ties (Ripple weighs time proximity too).
    if (sim > 0) return { score: sim + 0.5 * (1 - gap / MATCH_WINDOW_MS), reason: "title", gapMs: gap };
    // Time only (Ripple's third signal): always below any title pair.
    return { score: gap <= NEAR_TIME_MS ? 0.01 + 0.4 * (1 - gap / NEAR_TIME_MS) : 0, reason: "time", gapMs: gap };
  };
}

/** The links to write for one deal's posts. Pass only that deal's posts. */
export function matchCrossPosts(posts: readonly MatchPost[]): GroupLink[] {
  return matchCrossPostsDetailed(posts).links;
}

/** The links, plus the posts held back from a group that would zero them (for the dry run). */
export function matchCrossPostsDetailed(posts: readonly MatchPost[]): { links: GroupLink[]; held: HeldLink[] } {
  const tokens = new Map(posts.map((p) => [p.id, titleTokens(p.title)]));
  const score = pairScorer(posts, tokens);

  const members = new Map<string, MatchPost[]>();
  for (const p of posts) {
    if (p.video_group_id) members.set(p.video_group_id, [...(members.get(p.video_group_id) ?? []), p]);
  }
  // A lone post in an `auto-` group is a split left by a race: it is unlinked again.
  const lone = new Set<string>();
  for (const [groupId, rows] of members) {
    if (groupId.startsWith("auto-") && rows.length === 1 && !rows[0].video_group_manual) {
      lone.add(rows[0].id);
      members.delete(groupId);
    }
  }
  const fixed = new Map<string, Cluster>();
  const blocked = new Map<string, Set<string>>(); // group -> its platforms
  for (const [groupId, rows] of members) {
    if (rows.some((r) => r.video_group_manual)) continue; // the owner's
    const platforms = new Set(rows.map((r) => r.platform));
    if (rows.some(zeroes)) blocked.set(groupId, platforms);
    else fixed.set(groupId, { groupId, platforms, moved: [] });
  }

  const pool = posts
    .filter(
      (p) => (!p.video_group_id || lone.has(p.id)) && !p.video_group_manual && !dirty(p) && tokens.get(p.id)!.length > 0,
    )
    .sort((x, y) => (x.id < y.id ? -1 : 1));
  const clusterOf = new Map<string, Cluster>(
    pool.map((p) => [p.id, { groupId: null, platforms: new Set([p.platform]), moved: [p.id] }]),
  );

  const pairScore = (x: MatchPost, y: MatchPost) => score(x, y).score;
  const groupScore = (x: MatchPost, groupId: string) => Math.max(0, ...members.get(groupId)!.map((m) => pairScore(x, m)));

  // ponytail: O(n^2) pairs per deal (~125k for 500 posts); bucket by time if deals grow past a few thousand posts.
  const edges: Edge[] = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const score = pairScore(pool[i], pool[j]);
      if (score > 0) edges.push({ score, fixed: false, key: `${pool[i].id}:${pool[j].id}`, a: pool[i].id, b: pool[j].id });
    }
    for (const [groupId, cluster] of fixed) {
      if (cluster.platforms.has(pool[i].platform)) continue;
      const best = groupScore(pool[i], groupId);
      if (best > 0) edges.push({ score: best, fixed: true, key: `${pool[i].id}:g:${groupId}`, a: pool[i].id, b: `g:${groupId}` });
    }
  }
  // Strongest first; on a tie prefer joining an existing group; then a stable key.
  edges.sort((x, y) => y.score - x.score || Number(y.fixed) - Number(x.fixed) || (x.key < y.key ? -1 : 1));

  for (const e of edges) {
    const A = clusterOf.get(e.a)!;
    const B = e.b.startsWith("g:") ? fixed.get(e.b.slice(2))! : clusterOf.get(e.b)!;
    if (A === B || (A.groupId && B.groupId)) continue;
    if ([...A.platforms].some((p) => B.platforms.has(p))) continue; // one post per platform
    const [keep, gone] = A.groupId ? [A, B] : [B, A];
    for (const id of gone.moved) {
      keep.moved.push(id);
      clusterOf.set(id, keep);
    }
    for (const p of gone.platforms) keep.platforms.add(p);
  }

  const byId = new Map(posts.map((p) => [p.id, p]));
  const links: GroupLink[] = [];
  const held: HeldLink[] = [];
  for (const c of new Set([...clusterOf.values()])) {
    if (!c.groupId && c.moved.length < 2) {
      // Still a video on its own: name the zeroing group its twin sits in, if any.
      const post = byId.get(c.moved[0])!;
      let best: { groupId: string; score: number } | null = null;
      for (const [groupId, platforms] of blocked) {
        if (platforms.has(post.platform)) continue;
        const score = groupScore(post, groupId);
        if (score > 0 && (!best || score > best.score)) best = { groupId, score };
      }
      if (best) held.push({ postId: post.id, groupId: best.groupId });
      continue;
    }
    const groupId = c.groupId ?? `auto-${[...c.moved].sort()[0]}`;
    for (const postId of c.moved) {
      const from = byId.get(postId)!.video_group_id;
      if (from === groupId) continue; // a lone post whose new group keeps its own id
      links.push(from ? { postId, groupId, from } : { postId, groupId });
    }
  }
  const order = (x: { postId: string }, y: { postId: string }) => (x.postId < y.postId ? -1 : 1);
  return { links: links.sort(order), held: held.sort(order) };
}

/** A post (or the video it is in) that looks like the same video on another platform. */
export interface TwinSuggestion {
  /** The twin post: alone, or the closest member of its video. */
  twinId: string;
  /** The twin's video group; null when the twin is not linked yet. */
  groupId: string | null;
  reason: TwinReason;
  /** How far apart the two were posted. */
  gapMs: number;
  score: number;
  /** Linking pays the video $0: this post or a post of the twin's video is excluded or priced $0. */
  zeroes: boolean;
}

/** An unlinked post and its suggested twins, best first. */
export interface NeedsMatch {
  postId: string;
  twins: TwinSuggestion[];
}

/**
 * The posts of ONE deal that look like another platform's post of the same
 * video but are not linked: the matcher's scored candidates, including the
 * ones it holds back (the twin's video pays $0) and the ones it may not join (a
 * hand-linked video). Only an unlinked post is listed (no group, or alone in an
 * `auto-` group), never one the owner unlinked by hand; that one is never a
 * suggestion either. A twin video that already has the post's platform is not
 * a suggestion. Two unlinked posts that are each other's best twin are listed once.
 */
export function needsMatching(posts: readonly MatchPost[], max = 3): NeedsMatch[] {
  const tokens = new Map(posts.map((p) => [p.id, titleTokens(p.title)]));
  const score = pairScorer(posts, tokens);
  const members = new Map<string, MatchPost[]>();
  for (const p of posts) {
    if (p.video_group_id) members.set(p.video_group_id, [...(members.get(p.video_group_id) ?? []), p]);
  }
  const lone = (p: MatchPost) =>
    !!p.video_group_id && p.video_group_id.startsWith("auto-") && members.get(p.video_group_id)!.length === 1;
  const open = (p: MatchPost) => !p.video_group_manual && (!p.video_group_id || lone(p));
  const handUnlinked = (p: MatchPost) => !!p.video_group_manual && !p.video_group_id;

  const out: NeedsMatch[] = [];
  const bestOf = new Map<string, string>();
  const order = [...posts].filter(open).sort((x, y) => Date.parse(y.posted_at) - Date.parse(x.posted_at) || (x.id < y.id ? -1 : 1));
  for (const p of order) {
    const units = new Map<string, TwinSuggestion>();
    for (const q of posts) {
      if (q.id === p.id || handUnlinked(q)) continue;
      const unit = open(q) ? [q] : members.get(q.video_group_id!)!;
      if (unit.some((m) => m.platform === p.platform)) continue;
      const s = score(p, q);
      if (s.score <= 0) continue;
      const key = open(q) ? `p:${q.id}` : `g:${q.video_group_id}`;
      const had = units.get(key);
      if (had && had.score >= s.score) continue;
      units.set(key, {
        twinId: q.id,
        groupId: open(q) ? null : q.video_group_id,
        reason: s.reason,
        gapMs: s.gapMs,
        score: s.score,
        zeroes: zeroes(p) || unit.some(zeroes),
      });
    }
    const twins = [...units.values()].sort((a, b) => b.score - a.score || a.gapMs - b.gapMs || (a.twinId < b.twinId ? -1 : 1));
    if (twins.length === 0 || bestOf.get(twins[0].twinId) === p.id) continue;
    bestOf.set(p.id, twins[0].twinId);
    out.push({ postId: p.id, twins: twins.slice(0, max) });
  }
  return out;
}

/** The posts with the links applied (what the ledger sees after a write). */
export function applyLinks<T extends { id: string; video_group_id: string | null }>(
  posts: readonly T[],
  links: readonly GroupLink[],
): T[] {
  const to = new Map(links.map((l) => [l.postId, l.groupId]));
  return posts.map((p) => (to.has(p.id) ? { ...p, video_group_id: to.get(p.id)! } : p));
}
