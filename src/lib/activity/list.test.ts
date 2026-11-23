// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listActivityWith, toEntry, type ListRow } from "./list";

const NOW = new Date("2026-11-21T15:00:00Z");
const A = "a1000000-0000-4000-8000-000000000001";
const B = "a1000000-0000-4000-8000-000000000002";
const C = "a1000000-0000-4000-8000-000000000003";

const dbRow = (over: object = {}) => ({
  id: A,
  at: "2026-11-21T14:00:00.123456+00:00",
  actor: "you",
  undone_at: null,
  undo_of: null,
  kind: "db",
  row_count: 1,
  rows: [{ tbl: "planning_tasks", op: "delete", old: { id: "t1", title: "Film 6 Wordwise videos" }, new: null }],
  summary: null,
  has_inverse: null,
  ...over,
}) as unknown as ListRow;

function fake(rows: object[]) {
  const rpc = vi.fn<(name: string, args: object) => Promise<{ data: object[]; error: null }>>(async () => ({ data: rows, error: null }));
  return { db: { rpc } as unknown as SupabaseClient, rpc };
}

describe("listActivity", () => {
  it("builds the summary and details from the logged rows and the table labels", () => {
    const e = toEntry(
      dbRow({
        row_count: 3,
        rows: [
          { tbl: "deals", op: "delete", old: { id: "d1", brand_name: "Glow" }, new: null },
          { tbl: "posts", op: "delete", old: { id: "p1", url: "https://tiktok.com/@me/video/1" }, new: null },
          {
            tbl: "planning_tasks",
            op: "update",
            old: { id: "t1", title: "Plan", status_id: "c0000000-0000-4000-8000-000000000001", notes: "a", updated_at: "x" },
            new: { id: "t1", title: "Plan", status_id: "c0000000-0000-4000-8000-000000000002", notes: "b", updated_at: "y" },
          },
        ],
      }),
      NOW,
    );
    expect(e.summary).toBe('Deleted deal "Glow" and 2 more');
    expect(e.details).toEqual(['Deleted deal "Glow"', 'Deleted post "https://tiktok.com/@me/video/1"', 'Task "Plan": Status changed, Notes: a → b']);
    expect(e).toMatchObject({ id: A, actor: "you", canUndo: true, undoneAt: null, undoOf: null });
    expect(e.cannotUndo).toBeUndefined();
  });

  it("an undo reads as Restored, and shows its original", () => {
    const e = toEntry(dbRow({ undo_of: B, rows: [{ tbl: "planning_tasks", op: "insert", old: null, new: { id: "t1", title: "Plan" } }] }), NOW);
    expect(e.summary).toBe('Restored task "Plan"');
    expect(e.undoOf).toBe(B);
  });

  it("past 30 days or already undone it cannot be undone, with the reason", () => {
    expect(toEntry(dbRow({ at: "2026-10-20T14:00:00Z" }), NOW)).toMatchObject({ canUndo: false, cannotUndo: "expired" });
    expect(toEntry(dbRow({ undone_at: "2026-11-21T14:05:00Z" }), NOW)).toMatchObject({ canUndo: false, cannotUndo: "undone" });
  });

  it("an agent action with no rows: its own summary; outside Hydra when it has no inverse", () => {
    const agent = { kind: "agent", actor: "hydra", row_count: 0, rows: [], summary: "Sent an email to Ana" };
    expect(toEntry(dbRow({ ...agent, has_inverse: false }), NOW)).toMatchObject({
      summary: "Sent an email to Ana",
      actor: "hydra",
      details: [],
      canUndo: false,
      cannotUndo: "outside",
    });
    expect(toEntry(dbRow({ ...agent, actor: "routine", has_inverse: true }), NOW)).toMatchObject({ actor: "routine", canUndo: true });
  });

  it("pages newest first with a cursor of the database's own timestamp", async () => {
    const { db, rpc } = fake([dbRow({ id: A }), dbRow({ id: B, at: "2026-11-21T13:00:00.000001+00:00" }), dbRow({ id: C })]);
    const page = await listActivityWith(db, { limit: 2 }, NOW);
    expect(rpc).toHaveBeenCalledWith("activity_list", { p_before_at: null, p_before_id: null, p_limit: 3 });
    expect(page.entries.map((e) => e.id)).toEqual([A, B]);
    expect(page.next).toBe(`2026-11-21T13:00:00.000001+00:00|${B}`);

    const last = fake([dbRow({ id: C })]);
    const second = await listActivityWith(last.db, { before: page.next!, limit: 2 }, NOW);
    expect(last.rpc).toHaveBeenCalledWith("activity_list", { p_before_at: "2026-11-21T13:00:00.000001+00:00", p_before_id: B, p_limit: 3 });
    expect(second).toEqual({ entries: [expect.objectContaining({ id: C })], next: null });
  });

  it("ignores a bad cursor and throws on a database error", async () => {
    const { db, rpc } = fake([]);
    await listActivityWith(db, { before: "nonsense" });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_before_at: null });
    const broken = { rpc: async () => ({ data: null, error: { message: "boom" } }) } as unknown as SupabaseClient;
    await expect(listActivityWith(broken)).rejects.toThrow("activity: boom");
  });
});
