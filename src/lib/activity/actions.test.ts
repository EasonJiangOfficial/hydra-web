// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  rows: [] as object[],
  move: vi.fn<(from: string, to: string) => Promise<{ error: null }>>(async () => ({ error: null })),
  undoAction: vi.fn(),
  action: null as null | { id: string; undone_at: string | null; created_at: string },
  push: vi.fn(async () => ({ ok: true, value: "created" })),
  remove: vi.fn(async () => ({ ok: true, value: "removed" })),
  after: vi.fn((fn: () => unknown) => void fn()),
}));

type Row = Record<string, unknown>;
const db = {
  rpc: (name: string, args: object) => m.rpc(name, args),
  from: () => {
    // The two filters undo.ts and files.ts use: eq(activity_id) is ignored (one undo per test), in() narrows.
    const ins: [string, unknown[]][] = [];
    const q = {
      select: () => q,
      eq: () => q,
      in: (col: string, vals: unknown[]) => (ins.push([col, vals]), q),
      limit: () => q,
      order: () => q,
      then: (r: (v: unknown) => unknown) => r({ data: (m.rows as Row[]).filter((row) => ins.every(([c, v]) => v.includes(row[c]))), error: null }),
    };
    return q;
  },
  storage: { from: () => ({ move: m.move }) },
};
vi.mock("next/server", () => ({ after: m.after }));
vi.mock("@/lib/google/calendar", () => ({ pushToGoogle: m.push, removeFromGoogle: m.remove }));
vi.mock("@/lib/supabase/server", () => ({ createServerClient: async () => db }));
vi.mock("@/lib/agent/caller", () => ({ ownerSession: async () => db, ownerToolCtx: () => ({ ctx: true }) }));
vi.mock("@/lib/agent/config", () => ({ LIVE_GROUPS: new Set() }));
vi.mock("@/lib/agent/store", () => ({ supabaseStore: () => ({ getAction: async () => m.action }) }));
vi.mock("@/lib/agent/tools", () => ({ undoAction: m.undoAction }));

const { undoActivity, undoActivities } = await import("./actions");

const A = "a1000000-0000-4000-8000-000000000001";
const U = "a1000000-0000-4000-8000-0000000000aa";

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = [];
  m.action = null;
});

describe("undoActivity", () => {
  it("runs undo_activity and returns the undo's id", async () => {
    m.rpc.mockResolvedValue({ data: { ok: true, undoId: U }, error: null });
    expect(await undoActivity(A)).toEqual({ ok: true, undoId: U });
    expect(m.rpc).toHaveBeenCalledWith("undo_activity", { p_id: A, p_force: false });
    await undoActivity(A, { force: true });
    expect(m.rpc).toHaveBeenLastCalledWith("undo_activity", { p_id: A, p_force: true });
  });

  it("puts a restored document's file back from the trash; a redone delete sends it to the undo's trash", async () => {
    m.rpc.mockResolvedValue({ data: { ok: true, undoId: U }, error: null });
    m.rows = [
      { tbl: "tax_documents", op: "insert", old: null, new: { id: "d1", storage_path: "ugc/2026/w9.pdf" } },
      { tbl: "tax_documents", op: "delete", old: { id: "d2", storage_path: "ugc/2026/1099.pdf" }, new: null },
    ];
    await undoActivity(A);
    expect(m.move.mock.calls).toEqual([
      [`trash/${A}/ugc/2026/w9.pdf`, "ugc/2026/w9.pdf"],
      ["ugc/2026/1099.pdf", `trash/${U}/ugc/2026/1099.pdf`],
    ]);
  });

  it("changed since: one short line per changed row", async () => {
    m.rpc.mockResolvedValue({
      data: {
        ok: false,
        error: "changed_since",
        changed: [
          { tbl: "planning_tasks", what: "changed", cols: ["title", "status_id"], row: { title: "Plan W" } },
          { tbl: "deals", what: "gone", row: { brand_name: "Glow" } },
          { tbl: "planning_tasks", what: "back", row: { title: "Film" } },
        ],
      },
      error: null,
    });
    expect(await undoActivity(A)).toEqual({
      ok: false,
      error: "changed_since",
      changed: ['Task "Plan W": Title, Status changed since', 'Deal "Glow" is gone', 'Task "Film" is back'],
    });
  });

  it("passes expired and already_undone through; a database error is failed", async () => {
    m.rpc.mockResolvedValueOnce({ data: { ok: false, error: "expired" }, error: null });
    expect(await undoActivity(A)).toEqual({ ok: false, error: "expired" });
    m.rpc.mockResolvedValueOnce({ data: { ok: false, error: "already_undone" }, error: null });
    expect(await undoActivity(A)).toEqual({ ok: false, error: "already_undone" });
    m.rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    expect(await undoActivity(A)).toEqual({ ok: false, error: "failed" });
  });

  it("an agent action with no activity rows is undone by its tool inverse", async () => {
    m.rpc.mockResolvedValue({ data: { ok: false, error: "not_found" }, error: null });
    m.action = { id: A, undone_at: null, created_at: new Date().toISOString() };
    m.undoAction.mockResolvedValue({ status: "ok", data: null, summary: "Undid", actionId: U });
    expect(await undoActivity(A)).toEqual({ ok: true, undoId: U });
    expect(m.undoAction).toHaveBeenCalledWith(A, { ctx: true }, { approved: true, refuseLogged: true });

    m.action = { id: A, undone_at: null, created_at: "2026-01-01T00:00:00Z" };
    expect(await undoActivity(A)).toEqual({ ok: false, error: "expired" });
    m.action = null;
    expect(await undoActivity(A)).toEqual({ ok: false, error: "not_found" });
  });

  it("a restored Planning item goes back to Google; one the undo removed comes off it (F3)", async () => {
    m.rpc.mockResolvedValue({ data: { ok: true, undoId: U }, error: null });
    m.rows = [
      { tbl: "planning_tasks", op: "insert", pk: { id: "t1" } },
      { tbl: "events", op: "delete", pk: { id: "e1" } },
      { tbl: "planning_tasks", op: "update", pk: { id: "t2" } },
      { tbl: "deals", op: "insert", pk: { id: "d1" } },
    ];
    await undoActivity(A);
    expect(m.after).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(m.push).toHaveBeenCalledTimes(2));
    expect(m.push.mock.calls).toEqual([["task", "t1"], ["task", "t2"]]);
    expect(m.remove.mock.calls).toEqual([["event", "e1"]]);
  });

  it("blocked passes through, and its lines say why (F4)", async () => {
    m.rpc.mockResolvedValue({
      data: { ok: false, error: "changed_since", blocked: true, changed: [{ tbl: "categories", what: "blocked", why: "taken", msg: "duplicate key" }] },
      error: null,
    });
    expect(await undoActivity(A)).toEqual({ ok: false, error: "changed_since", blocked: true, changed: ["A category with the same name exists now"] });
  });

  it("a multi-call delete is undone in one call, in one transaction (F7)", async () => {
    const B = "a1000000-0000-4000-8000-000000000002";
    m.rpc.mockResolvedValue({ data: { ok: true, undoId: U, undoIds: ["a1000000-0000-4000-8000-0000000000bb", U] }, error: null });
    expect(await undoActivities([A, B])).toEqual({ ok: true, undoId: U });
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc).toHaveBeenCalledWith("undo_activities", { p_ids: [A, B], p_force: false });
    m.rpc.mockResolvedValue({ data: { ok: false, error: "already_undone" }, error: null });
    expect(await undoActivities([A, B])).toEqual({ ok: false, error: "already_undone" });
    expect(await undoActivities([A, "nope"])).toEqual({ ok: false, error: "not_found" });
  });

  it("refuses an id that is not a uuid without a call", async () => {
    expect(await undoActivity("1; drop table")).toEqual({ ok: false, error: "not_found" });
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
