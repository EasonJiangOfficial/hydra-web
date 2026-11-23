/**
 * Cross-post writes (writes.ts) on the in-memory PostgREST stand-in: an added
 * twin links itself, the owner's link and unlink return what changed, and the
 * matcher never undoes the owner's hand work.
 */
import { describe, it, expect } from "vitest";
import { memoryDb } from "@/app/api/ugc/v1/memory-db";
import { addPost, editPost, linkCrossPosts, linkPosts, unlinkPost, type Db } from "@/lib/ugc/writes";

const DEAL = "d1000000-0000-4000-8000-000000000001";
const OTHER = "d2000000-0000-4000-8000-000000000002";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function setup(posts: Record<string, unknown>[] = []) {
  const m = memoryDb({
    deals: [
      { id: DEAL, brand_name: "Wordwise" },
      { id: OTHER, brand_name: "Canvasly" },
    ],
    posts: posts.map((p) => ({ video_group_manual: false, video_group_id: null, exclude_from_pay: false, manual_override_cents: null, ...p })),
  });
  return { db: m.db as Db, rows: () => m.tables.posts };
}

const post = (n: number, platform: string, title: string | null, postedAt: string, over: Record<string, unknown> = {}) => ({
  id: id(n),
  deal_id: DEAL,
  platform,
  url: `https://example.com/${n}`,
  title,
  posted_at: postedAt,
  ...over,
});

describe("addPost links its cross-posts", () => {
  it("an Instagram twin added after its TikTok joins it as one video", async () => {
    const { db, rows } = setup([post(1, "TIKTOK", "this app writes my essays 😭 #wordwise", "2026-11-10T15:00:00Z")]);
    const r = await addPost(db, {
      dealId: DEAL,
      url: "https://www.instagram.com/reel/abc",
      platform: "INSTAGRAM",
      postedAt: "2026-11-10T19:00:00Z",
      title: "this app writes my essays #wordwise",
      source: "grokbot",
    });
    expect(r.ok).toBe(true);
    const groupId = `auto-${id(1)}`;
    expect(r.ok && r.data.post.video_group_id).toBe(groupId);
    expect(rows().map((p) => p.video_group_id)).toEqual([groupId, groupId]);
  });

  it("a different video the same day stays on its own", async () => {
    const { db } = setup([post(1, "TIKTOK", "rating every dining hall", "2026-11-10T15:00:00Z")]);
    const r = await addPost(db, {
      dealId: DEAL,
      url: "https://www.instagram.com/reel/xyz",
      platform: "INSTAGRAM",
      postedAt: "2026-11-10T16:00:00Z",
      title: "my morning routine",
      source: "hydra",
    });
    expect(r.ok && r.data.post.video_group_id).toBeNull();
  });

  it("a re-add never moves a post the owner grouped by hand", async () => {
    const { db, rows } = setup([
      post(1, "TIKTOK", "a", "2026-11-10T15:00:00Z", { url: "https://example.com/1", video_group_id: "hand", video_group_manual: true }),
    ]);
    const r = await addPost(db, {
      dealId: DEAL,
      url: "https://example.com/1",
      platform: "TIKTOK",
      postedAt: "2026-11-10T15:00:00Z",
      videoGroupId: "bot-group",
      source: "grokbot",
    });
    expect(r.ok && r.data.post.video_group_id).toBe("hand");
    expect(rows()[0].video_group_id).toBe("hand");
  });
});

describe("linkCrossPosts", () => {
  it("returns what it linked, and nothing on a rerun", async () => {
    const { db } = setup([
      post(1, "TIKTOK", "worst classes in college pt 3", "2026-11-10T15:00:00Z"),
      post(2, "INSTAGRAM", "worst classes in college pt 3", "2026-11-10T17:00:00Z", { video_group_id: "uv-1" }),
      post(3, "YOUTUBE", "worst classes in college pt 3 #shorts", "2026-11-10T18:00:00Z"),
    ]);
    expect(await linkCrossPosts(db, DEAL)).toEqual({
      ok: true,
      data: {
        dealId: DEAL,
        changes: [
          { postId: id(1), from: null, to: "uv-1" },
          { postId: id(3), from: null, to: "uv-1" },
        ],
      },
    });
    expect(await linkCrossPosts(db, DEAL)).toEqual({ ok: true, data: { dealId: DEAL, changes: [] } });
  });
});

describe("linkPosts / unlinkPost", () => {
  it("linking merges whole videos into the first group and marks them by hand", async () => {
    const { db, rows } = setup([
      post(1, "TIKTOK", "a", "2026-11-10T15:00:00Z", { video_group_id: "g-b" }),
      post(2, "INSTAGRAM", "b", "2026-11-10T15:00:00Z", { video_group_id: "g-b" }),
      post(3, "YOUTUBE", "c", "2026-11-12T15:00:00Z", { video_group_id: "g-a" }),
      post(4, "FACEBOOK", "d", "2026-11-12T15:00:00Z"),
    ]);
    const r = await linkPosts(db, { postIds: [id(1), id(3), id(4)] });
    expect(r).toEqual({
      ok: true,
      data: {
        dealId: DEAL,
        changes: [
          { postId: id(1), from: "g-b", to: "g-a" },
          { postId: id(2), from: "g-b", to: "g-a" },
          { postId: id(4), from: null, to: "g-a" },
        ],
      },
    });
    expect(rows().every((p) => p.video_group_id === "g-a" && p.video_group_manual === true)).toBe(true);
  });

  it("posts with no group get a new manual group", async () => {
    const { db } = setup([post(1, "TIKTOK", "a", "2026-11-10T15:00:00Z"), post(2, "TIKTOK", "b", "2026-11-10T15:00:00Z")]);
    const r = await linkPosts(db, { postIds: [id(2), id(1)] });
    const to = r.ok ? r.data.changes.map((c) => c.to) : [];
    expect(to).toHaveLength(2);
    expect(to[0]).toMatch(/^manual-/);
    expect(to[1]).toBe(to[0]);
  });

  it("posts on two deals cannot be one video; a missing post is not found", async () => {
    const { db } = setup([post(1, "TIKTOK", "a", "2026-11-10T15:00:00Z"), post(2, "INSTAGRAM", "a", "2026-11-10T15:00:00Z", { deal_id: OTHER })]);
    expect(await linkPosts(db, { postIds: [id(1), id(2)] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await linkPosts(db, { postIds: [id(1), id(9)] })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("unlinking takes the post out and the matcher never links it back", async () => {
    const { db, rows } = setup([
      post(1, "TIKTOK", "day in my life at college", "2026-11-10T15:00:00Z", { video_group_id: "auto-x" }),
      post(2, "INSTAGRAM", "day in my life at college", "2026-11-10T16:00:00Z", { video_group_id: "auto-x" }),
    ]);
    expect(await unlinkPost(db, { postId: id(2) })).toEqual({
      ok: true,
      data: { dealId: DEAL, changes: [{ postId: id(2), from: "auto-x", to: null }] },
    });
    expect(await linkCrossPosts(db, DEAL)).toEqual({ ok: true, data: { dealId: DEAL, changes: [] } });
    expect(rows()[1]).toMatchObject({ video_group_id: null, video_group_manual: true });
    expect(await unlinkPost(db, { postId: id(9) })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("a group set in an edit is a hand link", async () => {
    const { db, rows } = setup([post(1, "TIKTOK", "a", "2026-11-10T15:00:00Z")]);
    await editPost(db, { id: id(1), videoGroupId: "mine" });
    expect(rows()[0]).toMatchObject({ video_group_id: "mine", video_group_manual: true });
  });
});

// ─── Review findings (fix/ugc-cross-post-2) ─────────────────────────────────

describe("an add links only the new post's video", () => {
  it("an old unlinked pair stays for the reviewed backfill; the new post links its own twin", async () => {
    const { db, rows } = setup([
      post(1, "TIKTOK", "rating every dining hall", "2026-11-10T15:00:00Z"),
      post(2, "INSTAGRAM", "rating every dining hall", "2026-11-10T15:30:00Z"),
      post(3, "TIKTOK", "my morning routine as a student", "2026-11-10T18:00:00Z"),
    ]);
    const r = await addPost(db, {
      dealId: DEAL,
      url: "https://www.instagram.com/reel/new",
      platform: "INSTAGRAM",
      postedAt: "2026-11-10T19:00:00Z",
      title: "my morning routine as a student",
      source: "grokbot",
    });
    expect(r.ok && r.data.post.video_group_id).toBe(`auto-${id(3)}`);
    expect(rows().slice(0, 3).map((p) => p.video_group_id)).toEqual([null, null, `auto-${id(3)}`]);
  });

  it("a re-add (sync) of an old unlinked post links nothing", async () => {
    const { db, rows } = setup([
      post(1, "TIKTOK", "rating every dining hall", "2026-11-10T15:00:00Z"),
      post(2, "INSTAGRAM", "rating every dining hall", "2026-11-10T15:30:00Z"),
    ]);
    const r = await addPost(db, {
      dealId: DEAL,
      url: "https://example.com/1",
      platform: "TIKTOK",
      postedAt: "2026-11-10T15:00:00Z",
      source: "grokbot",
    });
    expect(r.ok && r.data.created).toBe(false);
    expect(rows().map((p) => p.video_group_id)).toEqual([null, null]);
  });
});

describe("two adds of one video racing end in one group", () => {
  it("a write that finds its rows already moved reads and matches again", async () => {
    // The new post's random id sorts below these, so this add names the group after it.
    const hi = (n: number) => `ffffffff-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const { db, rows } = setup([
      post(2, "TIKTOK", "day in my life at college", "2026-11-10T15:00:00Z", { id: hi(2) }),
      post(3, "YOUTUBE", "day in my life at college", "2026-11-10T15:20:00Z", { id: hi(3) }),
    ]);
    // The other add (of the YouTube post) writes its group between this add's read and its write.
    const from = db.from.bind(db);
    let raced = false;
    (db as { from: unknown }).from = (table: string) => {
      const b = from(table);
      const update = b.update.bind(b);
      (b as { update: unknown }).update = (v: Record<string, unknown>) => {
        if (table === "posts" && !raced && "video_group_id" in v) {
          raced = true;
          for (const p of rows()) if (p.id === hi(2) || p.id === hi(3)) p.video_group_id = `auto-${hi(2)}`;
        }
        return update(v);
      };
      return b;
    };
    const r = await addPost(db, {
      dealId: DEAL,
      url: "https://www.instagram.com/reel/race",
      platform: "INSTAGRAM",
      postedAt: "2026-11-10T15:10:00Z",
      title: "day in my life at college",
      source: "grokbot",
    });
    expect(raced).toBe(true);
    expect(rows().map((p) => p.video_group_id)).toEqual([`auto-${hi(2)}`, `auto-${hi(2)}`, `auto-${hi(2)}`]);
    expect(r.ok && r.data.post.video_group_id).toBe(`auto-${hi(2)}`);
  });

  it("a post a race already left alone in an auto- group rejoins on the next run", async () => {
    const { db, rows } = setup([
      post(1, "INSTAGRAM", "day in my life at college", "2026-11-10T15:10:00Z", { video_group_id: `auto-${id(1)}` }),
      post(2, "TIKTOK", "day in my life at college", "2026-11-10T15:00:00Z", { video_group_id: `auto-${id(2)}` }),
      post(3, "YOUTUBE", "day in my life at college", "2026-11-10T15:20:00Z", { video_group_id: `auto-${id(2)}` }),
    ]);
    expect(await linkCrossPosts(db, DEAL)).toEqual({
      ok: true,
      data: { dealId: DEAL, changes: [{ postId: id(1), from: `auto-${id(1)}`, to: `auto-${id(2)}` }] },
    });
    expect(rows().map((p) => p.video_group_id)).toEqual([`auto-${id(2)}`, `auto-${id(2)}`, `auto-${id(2)}`]);
  });
});

describe("a hand link never reuses a group left by an unlink", () => {
  it("link A+B, unlink A, link A+C: B is not pulled into A+C's video", async () => {
    const { db, rows } = setup([
      post(1, "TIKTOK", "a", "2026-11-10T15:00:00Z"),
      post(2, "INSTAGRAM", "b", "2026-11-10T15:00:00Z"),
      post(3, "YOUTUBE", "c", "2026-11-10T15:00:00Z"),
    ]);
    await linkPosts(db, { postIds: [id(1), id(2)] });
    await unlinkPost(db, { postId: id(1) });
    const r = await linkPosts(db, { postIds: [id(1), id(3)] });
    const [a, b, c] = rows();
    expect(a.video_group_id).toBe(c.video_group_id);
    expect(b.video_group_id).not.toBe(a.video_group_id);
    expect(r.ok && r.data.changes.map((x) => x.postId)).toEqual([id(1), id(3)]);
  });
});
