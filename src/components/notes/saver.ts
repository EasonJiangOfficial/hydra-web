import type { NoteDoc } from "@/lib/notes/doc";

import type { NoteListItem, NotePatch, SaveOptions, SaveOutcome } from "./types";

export type SaveState = "idle" | "saving" | "saved" | "error" | "conflict" | "gone";

/**
 * Autosave for one open note, so typing is never lost while the tab lives: edits wait `delay` ms, then
 * save as one compare-and-set on the updated_at this copy holds. Typing during a save queues the next
 * save. A failed save keeps the edit in memory and retries, waiting longer each time (`retry` doubling up
 * to `max`). Nothing counts as saved until the server says so.
 *
 * A conflict (the note changed elsewhere) stops saving and keeps the local copy: nothing is merged or
 * overwritten silently. The owner picks: Keep mine (`keepMine`, which saves the whole local copy over the
 * server's) or Reload (the page drops this saver and reads the server's copy). A note deleted elsewhere
 * stops saving.
 *
 * It outlives the open editor (the Notes page keeps one per note until its edits land): leaving a note
 * while its save fails keeps the edit and the retries, and opening it again shows the edit and carries on.
 */
export class NoteSaver {
  private pending: NotePatch = {};
  /** What the save on its way carries, until the server confirms it. */
  private sending: NotePatch = {};
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** Failed saves in a row: the next retry waits longer. */
  private fails = 0;
  /** The tab is hiding: saves go out with keepalive, so they land even if the page goes. */
  private leaving = false;
  /** The server's updated_at when a save found the note changed elsewhere: Keep mine saves over that one. */
  private theirs: string | null = null;
  private listener: ((s: SaveState) => void) | null;
  /** The last state, for an editor that opens this note again. */
  state: SaveState = "idle";

  constructor(
    private readonly id: string,
    private base: string,
    private readonly save: (id: string, patch: NotePatch, expected: string, options?: SaveOptions) => Promise<SaveOutcome>,
    /** `change`: the state or the edits owed moved (the page keeps its leave guards on while any are owed). */
    private readonly events: { state?: (s: SaveState) => void; saved: (note: NoteListItem) => void; change?: () => void },
    private readonly timing = { delay: 600, retry: 3000, max: 30_000 },
  ) {
    this.listener = events.state ?? null;
  }

  /** The updated_at this copy saves on: the loaded one, then each saved one. */
  get version(): string {
    return this.base;
  }

  /** Edits not on the server yet (a save failing, or stopped by a conflict). */
  get unsent(): NotePatch {
    return { ...this.sending, ...this.pending };
  }

  /** Unsaved edits, or a save still on its way. */
  get dirty(): boolean {
    return this.inFlight !== null || Object.keys(this.pending).length > 0;
  }

  /** Edits the server has not confirmed and still could (a deleted note has nowhere to save them). */
  get owed(): boolean {
    return this.dirty && this.state !== "gone";
  }

  /** The open editor follows the state; returns the unwatch. */
  watch(fn: (s: SaveState) => void): () => void {
    this.listener = fn;
    return () => {
      if (this.listener === fn) this.listener = null;
    };
  }

  private set(s: SaveState) {
    this.state = s;
    this.listener?.(s);
    this.events.change?.();
  }

  edit(patch: NotePatch): void {
    Object.assign(this.pending, patch);
    this.leaving = false; // typing: the tab is back
    // New typing is not saved yet: the note says Saved again only once the server confirms it.
    if (this.state === "saved") this.set("idle");
    else this.events.change?.();
    if (this.stopped) return;
    this.later(this.timing.delay);
  }

  /**
   * Save now (leaving the note, the tab hiding, back online). Resolves when nothing is waiting or saving
   * stopped. `keepalive`: the tab is hiding, so the save must outlive the page.
   */
  async flush(options: SaveOptions = {}): Promise<void> {
    if (options.keepalive) this.leaving = true;
    clearTimeout(this.timer);
    if (this.stopped) return;
    if (this.inFlight) {
      await this.inFlight; // it saves what came in meanwhile before it settles
      return;
    }
    if (!Object.keys(this.pending).length) return;
    const sent = this.pending;
    this.pending = {};
    this.set("saving");
    this.inFlight = this.send(sent);
    await this.inFlight;
  }

  /** Changed elsewhere, and the owner keeps theirs: the whole local copy saves over the server's. */
  async keepMine(copy: { title: string; doc: NoteDoc }): Promise<void> {
    if (this.state !== "conflict" || this.theirs === null) return;
    this.base = this.theirs;
    this.theirs = null;
    this.pending = { ...copy };
    this.stopped = false;
    await this.flush();
  }

  /** Stops saving for good (the note was deleted here, or the owner reloaded the server's copy). */
  dispose(): void {
    clearTimeout(this.timer);
    this.stopped = true;
  }

  private later(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), ms);
  }

  private async send(sent: NotePatch): Promise<void> {
    this.sending = sent;
    let r: SaveOutcome;
    try {
      r = await this.save(this.id, sent, this.base, this.leaving ? { keepalive: true } : undefined);
    } catch {
      r = { ok: false, reason: "failed" };
    }
    this.sending = {};
    if (r.ok) {
      this.fails = 0;
      this.base = r.note.updated_at;
      this.events.saved(r.note);
    } else {
      this.pending = { ...sent, ...this.pending }; // newer typing wins over what was sent
    }
    if (!r.ok && r.reason !== "failed") {
      if (r.reason === "conflict") this.theirs = r.note.updated_at;
      this.stopped = true;
      this.inFlight = null;
      this.set(r.reason);
      return;
    }
    if (!r.ok) {
      this.inFlight = null;
      this.set("error");
      this.later(Math.min(this.timing.retry * 2 ** this.fails++, this.timing.max));
      return;
    }
    if (Object.keys(this.pending).length) {
      // Typed during the save: send the rest at once, on the new updated_at.
      const next = this.pending;
      this.pending = {};
      await this.send(next);
      return;
    }
    this.inFlight = null;
    this.set("saved");
  }
}
