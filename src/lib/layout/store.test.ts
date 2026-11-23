import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadLayoutRows, resetLayoutRow, saveInputSchema, saveLayoutRow } from "./store";

const USER = "11111111-1111-1111-1111-111111111111";
const ITEMS = [{ id: "recent", x: 0, y: 0, w: 4, h: 5 }];

type Row = { user_id: string; breakpoint: string; items: unknown; updated_at: string };

/**
 * An in-memory dashboard_layouts behind the slice of the supabase-js builder that store.ts uses.
 * updated_at carries microseconds, like Postgres, so the test proves the text is passed back untouched.
 */
function fakeDb(rows: Row[], opts: { failWith?: string } = {}) {
  let tick = 0;
  const stamp = () => `2026-11-21T18:00:00.${String(++tick).padStart(6, "0")}+00:00`;
  const from = () => {
    const filters: [string, unknown][] = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Record<string, unknown> = {};
    const matches = () => rows.filter((r) => filters.every(([k, v]) => (r as Record<string, unknown>)[k] === v));
    const run = (): { data: unknown; error: { code: string } | null } => {
      if (opts.failWith) return { data: null, error: { code: opts.failWith } };
      if (op === "insert") {
        if (rows.some((r) => r.user_id === payload.user_id && r.breakpoint === payload.breakpoint))
          return { data: null, error: { code: "23505" } };
        const row = { ...payload, updated_at: stamp() } as Row;
        rows.push(row);
        return { data: row, error: null };
      }
      if (op === "update") {
        const hit = matches();
        hit.forEach((r) => Object.assign(r, payload, { updated_at: stamp() }));
        return { data: hit, error: null };
      }
      if (op === "delete") {
        for (const r of matches()) rows.splice(rows.indexOf(r), 1);
        return { data: null, error: null };
      }
      return { data: matches(), error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: Record<string, unknown>) => ((op = "insert"), (payload = p), b),
      update: (p: Record<string, unknown>) => ((op = "update"), (payload = p), b),
      delete: () => ((op = "delete"), b),
      eq: (k: string, v: unknown) => (filters.push([k, v]), b),
      returns: () => b,
      single: () => {
        const r = run();
        return Promise.resolve({ ...r, data: r.error ? null : r.data });
      },
      maybeSingle: () => {
        const r = run();
        return Promise.resolve({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data });
      },
      then: (ok: (v: unknown) => unknown) => Promise.resolve(run()).then(ok),
    };
    return b;
  };
  return { db: { from } as unknown as SupabaseClient, rows };
}

const save = (db: SupabaseClient, expectedUpdatedAt: string | null, items: unknown = ITEMS, breakpoint = "desktop") =>
  saveLayoutRow(db, USER, saveInputSchema.parse({ breakpoint, items, expectedUpdatedAt }));

describe("saveLayoutRow", () => {
  it("inserts the first save and returns the token", async () => {
    const { db, rows } = fakeDb([]);
    const r = await save(db, null);
    expect(r).toEqual({ ok: true, updatedAt: rows[0].updated_at });
    expect(rows).toHaveLength(1);
  });

  it("updates when the token matches, and hands back the new one", async () => {
    const { db, rows } = fakeDb([]);
    const first = await save(db, null);
    if (!first.ok) throw new Error("first save failed");
    const next = [{ id: "recent", x: 4, y: 0, w: 4, h: 5 }];
    const r = await save(db, first.updatedAt, next);
    expect(r.ok).toBe(true);
    expect(r.ok && r.updatedAt).not.toBe(first.updatedAt);
    expect(rows[0].items).toEqual(next);
  });

  it("loses with the newer layout when the token is stale", async () => {
    const { db, rows } = fakeDb([]);
    const first = await save(db, null);
    if (!first.ok) throw new Error("first save failed");
    const winner = [{ id: "goals", x: 0, y: 0, w: 6, h: 4 }];
    await save(db, first.updatedAt, winner); // the other tab wins
    const loser = await save(db, first.updatedAt, [{ id: "ugc", x: 0, y: 0, w: 4, h: 5 }]);
    expect(loser).toEqual({ ok: false, reason: "conflict", current: { items: winner, updatedAt: rows[0].updated_at } });
    expect(rows[0].items).toEqual(winner);
  });

  it("loses a first save to a row that already exists", async () => {
    const { db, rows } = fakeDb([]);
    await save(db, null);
    const r = await save(db, null, [{ id: "ugc", x: 0, y: 0, w: 4, h: 5 }]);
    expect(r).toMatchObject({ ok: false, reason: "conflict", current: { items: ITEMS } });
    expect(rows).toHaveLength(1);
  });

  it("answers conflict with no current layout when the row was reset", async () => {
    const { db } = fakeDb([]);
    const first = await save(db, null);
    if (!first.ok) throw new Error("first save failed");
    await resetLayoutRow(db, USER, "desktop");
    expect(await save(db, first.updatedAt)).toEqual({ ok: false, reason: "conflict", current: null });
  });

  it("keeps the two breakpoints apart", async () => {
    const { db, rows } = fakeDb([]);
    await save(db, null, ITEMS, "desktop");
    expect((await save(db, null, ITEMS, "phone")).ok).toBe(true);
    expect(rows.map((r) => r.breakpoint).sort()).toEqual(["desktop", "phone"]);
  });

  it("reports a database failure as an error, not a conflict", async () => {
    const { db } = fakeDb([], { failWith: "XX000" });
    expect(await save(db, null)).toEqual({ ok: false, reason: "error" });
    expect(await save(db, "2026-11-21T18:00:00.000001+00:00")).toEqual({ ok: false, reason: "error" });
  });
});

describe("saveInputSchema", () => {
  it("rejects a bad breakpoint, bad items and too many items", () => {
    const ok = { breakpoint: "desktop", items: ITEMS, expectedUpdatedAt: null };
    expect(saveInputSchema.safeParse(ok).success).toBe(true);
    expect(saveInputSchema.safeParse({ ...ok, breakpoint: "tablet" }).success).toBe(false);
    expect(saveInputSchema.safeParse({ ...ok, items: [{ id: "a", x: -1, y: 0, w: 1, h: 1 }] }).success).toBe(false);
    expect(saveInputSchema.safeParse({ ...ok, items: [{ id: "a", x: 0, y: 0, w: 1.5, h: 1 }] }).success).toBe(false);
    expect(saveInputSchema.safeParse({ ...ok, items: Array(65).fill(ITEMS[0]) }).success).toBe(false);
    expect(saveInputSchema.safeParse({ ...ok, expectedUpdatedAt: undefined }).success).toBe(false);
  });
});

describe("loadLayoutRows and resetLayoutRow", () => {
  it("loads what is saved and null where nothing is", async () => {
    const { db } = fakeDb([]);
    expect(await loadLayoutRows(db)).toEqual({ desktop: null, phone: null });
    await save(db, null, ITEMS, "phone");
    const loaded = await loadLayoutRows(db);
    expect(loaded.desktop).toBeNull();
    expect(loaded.phone).toMatchObject({ items: ITEMS });
  });

  it("reset deletes only that breakpoint", async () => {
    const { db, rows } = fakeDb([]);
    await save(db, null, ITEMS, "desktop");
    await save(db, null, ITEMS, "phone");
    expect(await resetLayoutRow(db, USER, "desktop")).toEqual({ ok: true });
    expect(rows.map((r) => r.breakpoint)).toEqual(["phone"]);
    expect(await resetLayoutRow(fakeDb([], { failWith: "XX000" }).db, USER, "phone")).toEqual({ ok: false, reason: "error" });
  });
});
