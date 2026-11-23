/**
 * The shared contract for Activity and undo (owner, 2026-11-21: "I should be able to undo deletions
 * and undo past behaviors"; undo covers pages and the agent; deleted items stay restorable 30 days;
 * the history lives on its own Activity page). The data unit implements it; the pages read it.
 */

/** Who made a change. "you": the owner on a page. "hydra": the agent. "routine": an unattended routine run. */
export type ActivityActor = "you" | "hydra" | "routine";

export type ActivityEntry = {
  id: string;
  /** ISO timestamp. */
  at: string;
  actor: ActivityActor;
  /** One short line, e.g. `Deleted task "Film 6 Wordwise videos"`. */
  summary: string;
  /** One short line per changed row (at most 20), e.g. `Status: Not started → In progress`. */
  details: string[];
  undoneAt: string | null;
  /** Set when this entry is itself an undo, so undoing it redoes the original. */
  undoOf: string | null;
  canUndo: boolean;
  /** Why it cannot be undone: past the 30 days, already undone, or it acted outside Hydra (a sent email). */
  cannotUndo?: "expired" | "undone" | "outside";
};

export type ActivityPage = { entries: ActivityEntry[]; next: string | null };

export type UndoResult =
  | { ok: true; undoId: string }
  /** `blocked`: the undo would break a rule (a name taken since, a row the owner may not write); undoing anyway cannot help. */
  | { ok: false; error: "changed_since"; changed: string[]; blocked?: boolean }
  | { ok: false; error: "expired" | "already_undone" | "not_found" | "failed" };

/** How long an action stays undoable and deleted rows are kept (owner, 2026-11-21). */
export const UNDO_DAYS = 30;
