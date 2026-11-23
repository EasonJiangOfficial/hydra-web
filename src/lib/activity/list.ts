import type { SupabaseClient } from "@supabase/supabase-js";
import { detailLine, summaryLine, type LoggedRow } from "./summary";
import { UNDO_DAYS, type ActivityActor, type ActivityEntry, type ActivityPage } from "./types";

export type ListRow = {
  id: string;
  at: string;
  actor: ActivityActor;
  undone_at: string | null;
  undo_of: string | null;
  kind: "db" | "agent";
  row_count: number;
  rows: LoggedRow[];
  summary: string | null;
  has_inverse: boolean | null;
};

const DAY_MS = 86_400_000;

/** One entry from a row of activity_list (a logged database action, or an agent action with no rows). */
export function toEntry(r: ListRow, now: Date = new Date()): ActivityEntry {
  const expired = now.getTime() - new Date(r.at).getTime() > UNDO_DAYS * DAY_MS;
  const base = { id: r.id, at: new Date(r.at).toISOString(), actor: r.actor, undoneAt: r.undone_at, undoOf: r.undo_of };
  if (r.kind === "agent") {
    const cannotUndo = r.undone_at ? "undone" : expired ? "expired" : !r.has_inverse ? "outside" : undefined;
    return { ...base, summary: r.summary || "Hydra action", details: [], canUndo: !cannotUndo, ...(cannotUndo ? { cannotUndo } : {}) };
  }
  const rows = r.rows ?? [];
  const cannotUndo = r.undone_at ? "undone" : expired ? "expired" : undefined;
  return {
    ...base,
    summary: summaryLine(rows, r.row_count, r.undo_of !== null),
    details: rows.slice(0, 20).map(detailLine),
    canUndo: !cannotUndo && r.row_count > 0,
    ...(cannotUndo ? { cannotUndo } : {}),
  };
}

/** The cursor is "<iso at>|<id>" of the last entry. */
function parseCursor(before?: string): { at: string; id: string } | null {
  if (!before) return null;
  const [at, id] = before.split("|");
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { at, id };
}

export async function listActivityWith(
  db: SupabaseClient,
  opts: { before?: string; limit?: number } = {},
  now: Date = new Date(),
): Promise<ActivityPage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const cursor = parseCursor(opts.before);
  const { data, error } = await db.rpc("activity_list", {
    p_before_at: cursor?.at ?? null,
    p_before_id: cursor?.id ?? null,
    p_limit: limit + 1,
  });
  if (error) throw new Error(`activity: ${error.message}`);
  const rows = (data ?? []) as ListRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    entries: page.map((r) => toEntry(r, now)),
    // The database's own timestamp (microseconds), so the next page neither skips nor repeats.
    next: rows.length > limit && last ? `${last.at}|${last.id}` : null,
  };
}
