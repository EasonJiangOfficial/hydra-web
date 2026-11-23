import type { SupabaseClient } from "@supabase/supabase-js";
import type { NoteRow } from "./queries";

/**
 * Tests only: an in-memory `notes` table behind the few Supabase calls queries.ts makes. It keeps
 * the database's rules that the code relies on: client_id is unique (23505), and updated_at moves
 * only when the title or the document changes (0210_notes.sql).
 */
export function memoryNotesDb(seed: NoteRow[] = [], clock: () => string = () => new Date().toISOString()) {
  const rows = seed.map((r) => ({ ...r }));
  let n = 0;
  const from = (table: string) => {
    if (table !== "notes") throw new Error(`no table ${table}`);
    let op: "select" | "insert" | "update" | "delete" = "select";
    let value: Record<string, unknown> = {};
    let single = false;
    let search: string | null = null;
    let cols: string[] | null = null;
    const pick = (r: NoteRow) => (cols ? Object.fromEntries(cols.map((c) => [c, (r as Record<string, unknown>)[c]])) : { ...r });
    const filters: [string, unknown][] = [];
    const run = () => {
      const match = (r: NoteRow) => filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v);
      if (op === "insert") {
        if (value.client_id && rows.some((r) => r.client_id === value.client_id)) return { data: null, error: { code: "23505", message: "duplicate key" } };
        const at = clock();
        const row = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, pinned: false, created_at: at, updated_at: at, ...value } as NoteRow;
        rows.push(row);
        return { data: pick(row), error: null };
      }
      let hit = rows.filter(match);
      if (search) {
        const terms = search.split(" & ").map((t) => t.replace(/:\*$/, ""));
        hit = hit.filter((r) => terms.every((t) => `${r.title} ${r.text}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(t))));
      }
      if (op === "update") {
        for (const r of hit) {
          const moved = ("title" in value && value.title !== r.title) || ("doc" in value && JSON.stringify(value.doc) !== JSON.stringify(r.doc));
          Object.assign(r, value, { updated_at: moved ? clock() : r.updated_at });
        }
      }
      if (op === "delete") for (const r of hit) rows.splice(rows.indexOf(r), 1);
      const data = hit.map(pick);
      return { data: single ? (data[0] ?? null) : data, error: null };
    };
    const b = {
      select: (c?: string) => ((cols = c ? c.split(",").map((x) => x.trim()) : null), b),
      insert: (v: Record<string, unknown>) => ((op = "insert"), (value = v), b),
      update: (v: Record<string, unknown>) => ((op = "update"), (value = v), b),
      delete: () => ((op = "delete"), b),
      eq: (c: string, v: unknown) => (filters.push([c, v]), b),
      textSearch: (_c: string, q: string) => ((search = q), b),
      order: () => b,
      limit: () => b,
      single: () => ((single = true), b),
      maybeSingle: () => ((single = true), b),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    };
    return b;
  };
  return { rows, db: { from } as unknown as SupabaseClient };
}
