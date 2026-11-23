import type { Activity } from "./types";

/** Consecutive rows with the same label, shown as one row with a count until opened. */
export type ActivityRun = { key: string; label: string; rows: Activity[] };

/** Runs of identical labels, in order (the list is newest first). */
export function runsOf(rows: Activity[]): ActivityRun[] {
  const runs: ActivityRun[] = [];
  for (const row of rows) {
    const last = runs.at(-1);
    if (last && last.label === row.label) last.rows.push(row);
    else runs.push({ key: row.id, label: row.label, rows: [row] });
  }
  return runs;
}

/** The panel's two groups: what this conversation changed, and everything else. */
export function groupActivity(rows: Activity[], threadId: string | null): { here: ActivityRun[]; earlier: ActivityRun[] } {
  const here = threadId ? rows.filter((r) => r.threadId === threadId) : [];
  return { here: runsOf(here), earlier: runsOf(rows.filter((r) => !here.includes(r))) };
}

/** This conversation has a change that can still be undone (the header button's dot). */
export const canUndoHere = (rows: Activity[], threadId: string | null) => !!threadId && rows.some((r) => r.threadId === threadId && !!r.undoId);

const SURFACE: Record<string, string> = { web: "Web", phone: "Phone", desktop: "Mac", routine: "Routine", mcp: "Outside tool" };

/** When and where, for the row's hover: "Nov 22, 3:04 PM · Phone". */
export function whenWhere(row: Pick<Activity, "createdAt" | "surface">): string | undefined {
  const at = row.createdAt ? new Date(row.createdAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const where = row.surface ? (SURFACE[row.surface] ?? row.surface) : "";
  return [when, where].filter(Boolean).join(" · ") || undefined;
}
