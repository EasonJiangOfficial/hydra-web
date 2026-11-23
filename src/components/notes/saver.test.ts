// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteSaver, type SaveState } from "./saver";
import type { NoteFull, NoteListItem, NotePatch, SaveOptions, SaveOutcome } from "./types";

const ID = "00000000-0000-4000-8000-000000000001";
const row = (updated_at: string): NoteListItem => ({ id: ID, title: "", preview: "", source: "web", pinned: false, created_at: "t0", updated_at });
const server = (updated_at: string, over: Partial<NoteFull> = {}): NoteFull => ({ ...row(updated_at), doc: [], ...over });

/** A save the test answers by hand. */
function manualSave() {
  const calls: { patch: NotePatch; expected: string; options?: SaveOptions; answer: (r: SaveOutcome | Error) => void }[] = [];
  const save = (_id: string, patch: NotePatch, expected: string, options?: SaveOptions) =>
    new Promise<SaveOutcome>((ok, bad) => calls.push({ patch, expected, options, answer: (r) => (r instanceof Error ? bad(r) : ok(r)) }));
  return { calls, save };
}

describe("NoteSaver", () => {
  let states: SaveState[];
  let saved: NoteListItem[];
  const events = () => ({ state: (s: SaveState) => states.push(s), saved: (n: NoteListItem) => saved.push(n) });
  beforeEach(() => {
    vi.useFakeTimers();
    states = [];
    saved = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits 600 ms after the last edit, then saves once with everything, on the loaded updated_at", async () => {
    const m = manualSave();
    const s = new NoteSaver(ID, "v0", m.save, events());
    s.edit({ title: "T" });
    await vi.advanceTimersByTimeAsync(400);
    s.edit({ doc: [{ type: "paragraph" }] });
    await vi.advanceTimersByTimeAsync(599);
    expect(m.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({ patch: { title: "T", doc: [{ type: "paragraph" }] }, expected: "v0" });
    expect(s.dirty).toBe(true);
    m.calls[0].answer({ ok: true, note: row("v1") });
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(["saving", "saved"]);
    expect(saved.map((n) => n.updated_at)).toEqual(["v1"]);
    expect(s.dirty).toBe(false);
  });

  it("new typing after a save is not Saved until the server confirms it; each move tells the page", async () => {
    const m = manualSave();
    let changes = 0;
    const s = new NoteSaver(ID, "v0", m.save, { ...events(), change: () => changes++ });
    s.edit({ title: "a" });
    expect(changes).toBe(1);
    await vi.advanceTimersByTimeAsync(600);
    m.calls[0].answer({ ok: true, note: row("v1") });
    await vi.advanceTimersByTimeAsync(0);
    expect(s).toMatchObject({ state: "saved", owed: false });
    s.edit({ title: "ab" });
    expect(s).toMatchObject({ state: "idle", owed: true });
    await vi.advanceTimersByTimeAsync(600);
    expect(s.state).toBe("saving");
    m.calls[1].answer({ ok: true, note: row("v2") });
    await vi.advanceTimersByTimeAsync(0);
    expect(s).toMatchObject({ state: "saved", owed: false });
    expect(states).toEqual(["saving", "saved", "idle", "saving", "saved"]);
    expect(changes).toBe(6); // two edits, four state moves
  });

  it("typing during a save queues the next save on the new updated_at", async () => {
    const m = manualSave();
    const s = new NoteSaver(ID, "v0", m.save, events());
    s.edit({ title: "A" });
    await vi.advanceTimersByTimeAsync(600);
    s.edit({ title: "AB" });
    await vi.advanceTimersByTimeAsync(600);
    expect(m.calls).toHaveLength(1); // one save at a time
    m.calls[0].answer({ ok: true, note: row("v1") });
    await vi.advanceTimersByTimeAsync(0);
    expect(m.calls[1]).toMatchObject({ patch: { title: "AB" }, expected: "v1" });
    m.calls[1].answer({ ok: true, note: row("v2") });
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toBe("saved");
    expect(s.dirty).toBe(false);
  });

  it("a failed save keeps the edit and retries; newer typing wins over what was sent", async () => {
    const m = manualSave();
    const s = new NoteSaver(ID, "v0", m.save, events());
    s.edit({ title: "A", doc: [] });
    await vi.advanceTimersByTimeAsync(600);
    s.edit({ title: "AB" });
    m.calls[0].answer(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(["saving", "error"]);
    expect(s.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(m.calls[1]).toMatchObject({ patch: { title: "AB", doc: [] }, expected: "v0" });
    m.calls[1].answer({ ok: true, note: row("v1") });
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toBe("saved");
  });

  it("a conflict stops saving and keeps the local copy: nothing is overwritten", async () => {
    const m = manualSave();
    const s = new NoteSaver(ID, "v0", m.save, events());
    s.edit({ title: "Mine" });
    await vi.advanceTimersByTimeAsync(600);
    m.calls[0].answer({ ok: false, reason: "conflict", note: server("v9") });
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(["saving", "conflict"]);
    s.edit({ title: "Mine 2" });
    await vi.advanceTimersByTimeAsync(10_000);
    await s.flush();
    expect(m.calls).toHaveLength(1);
    expect(s.dirty).toBe(true);
  });

  it("flush saves at once (leaving the note) and a gone note stops", async () => {
    const m = manualSave();
    const s = new NoteSaver(ID, "v0", m.save, events());
    s.edit({ title: "Bye" });
    const done = s.flush();
    expect(m.calls).toHaveLength(1);
    m.calls[0].answer({ ok: false, reason: "gone" });
    await done;
    expect(states).toEqual(["saving", "gone"]);
  });

  it("outlives the editor: leaving a note while its save fails keeps the edit and the retries", async () => {
    const m = manualSave();
    const s = new NoteSaver(ID, "v0", m.save, { saved: (n) => saved.push(n) });
    const unwatch = s.watch((st) => states.push(st));
    s.edit({ title: "A" });
    // The owner leaves the note (the editor unmounts: it stops watching and flushes) while offline.
    unwatch();
    const left = s.flush();
    m.calls[0].answer(new Error("offline"));
    await left;
    expect(states).toEqual([]); // nobody watches after the editor is gone
    expect(s.state).toBe("error");
    expect(s.unsent).toEqual({ title: "A" });
    // Back online: the retry still runs, and the note opened again sees the saved state.
    await vi.advanceTimersByTimeAsync(3000);
    expect(m.calls[1]).toMatchObject({ patch: { title: "A" }, expected: "v0" });
    m.calls[1].answer({ ok: true, note: row("v1") });
    await vi.advanceTimersByTimeAsync(0);
    expect(s).toMatchObject({ state: "saved", dirty: false, version: "v1", unsent: {} });
    expect(saved.map((n) => n.updated_at)).toEqual(["v1"]);
  });

  it("a failed save retries later each time, up to the cap, and a save resets the wait", async () => {
    const m = manualSave();
    const s = new NoteSaver(ID, "v0", m.save, events(), { delay: 600, retry: 1000, max: 4000 });
    s.edit({ title: "A" });
    await vi.advanceTimersByTimeAsync(600);
    const at: number[] = [];
    for (let i = 0; i < 5; i++) {
      const before = m.calls.length;
      m.calls.at(-1)!.answer(new Error("offline"));
      let waited = 0;
      while (m.calls.length === before) {
        await vi.advanceTimersByTimeAsync(100);
        waited += 100;
      }
      at.push(waited);
    }
    expect(at).toEqual([1000, 2000, 4000, 4000, 4000]);
    m.calls.at(-1)!.answer({ ok: true, note: row("v1") });
    await vi.advanceTimersByTimeAsync(0);
    s.edit({ title: "AB" });
    await vi.advanceTimersByTimeAsync(600);
    m.calls.at(-1)!.answer(new Error("offline"));
    await vi.advanceTimersByTimeAsync(999);
    const n = m.calls.length;
    await vi.advanceTimersByTimeAsync(1);
    expect(m.calls.length).toBe(n + 1);
  });

  it("a conflict is never taken as saved, even when the server holds what was sent", async () => {
    const m = manualSave();
    const s = new NoteSaver(ID, "v1", m.save, events());
    s.edit({ title: "Groceries" }); // typed and deleted a letter: the same title as the server's
    await vi.advanceTimersByTimeAsync(600);
    m.calls[0].answer({ ok: false, reason: "conflict", note: server("v2", { title: "Groceries", doc: [{ type: "paragraph" }] }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.state).toBe("conflict");
    expect(saved).toEqual([]);
    expect(s.version).toBe("v1");
  });

  it("Keep mine saves the whole local copy over the server's updated_at, then carries on", async () => {
    const m = manualSave();
    const s = new NoteSaver(ID, "v1", m.save, events());
    s.edit({ title: "Mine" });
    await vi.advanceTimersByTimeAsync(600);
    m.calls[0].answer({ ok: false, reason: "conflict", note: server("v5", { title: "Theirs" }) });
    await vi.advanceTimersByTimeAsync(0);
    s.edit({ title: "Mine, more" }); // typing under the banner is kept, not sent
    await vi.advanceTimersByTimeAsync(5000);
    expect(m.calls).toHaveLength(1);
    const kept = s.keepMine({ title: "Mine, more", doc: [{ type: "paragraph" }] });
    expect(m.calls[1]).toMatchObject({ patch: { title: "Mine, more", doc: [{ type: "paragraph" }] }, expected: "v5" });
    m.calls[1].answer({ ok: true, note: row("v6") });
    await kept;
    expect(s).toMatchObject({ state: "saved", dirty: false, version: "v6" });
    s.edit({ title: "Next" });
    await vi.advanceTimersByTimeAsync(600);
    expect(m.calls[2]).toMatchObject({ patch: { title: "Next" }, expected: "v6" });
  });

  it("Keep mine that finds the note changed again stops on a conflict again", async () => {
    const m = manualSave();
    const s = new NoteSaver(ID, "v1", m.save, events());
    s.edit({ title: "Mine" });
    await vi.advanceTimersByTimeAsync(600);
    m.calls[0].answer({ ok: false, reason: "conflict", note: server("v5") });
    await vi.advanceTimersByTimeAsync(0);
    const kept = s.keepMine({ title: "Mine", doc: [] });
    m.calls[1].answer({ ok: false, reason: "conflict", note: server("v7") });
    await kept;
    expect(s).toMatchObject({ state: "conflict", dirty: true, unsent: { title: "Mine", doc: [] } });
    expect(saved).toEqual([]);
  });

  it("a flush as the tab hides sends with keepalive; typing again sends normally", async () => {
    const m = manualSave();
    const s = new NoteSaver(ID, "v0", m.save, events());
    s.edit({ title: "A" });
    void s.flush({ keepalive: true });
    expect(m.calls[0].options).toEqual({ keepalive: true });
    m.calls[0].answer({ ok: true, note: row("v1") });
    await vi.advanceTimersByTimeAsync(0);
    s.edit({ title: "AB" });
    await vi.advanceTimersByTimeAsync(600);
    expect(m.calls[1].options).toBeUndefined();
  });

  it("an unsent edit is owed until it lands; a note deleted elsewhere owes nothing but keeps the typing", async () => {
    const m = manualSave();
    const s = new NoteSaver(ID, "v0", m.save, events());
    expect(s.owed).toBe(false);
    s.edit({ title: "Typed into a deleted note" });
    expect(s.owed).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    m.calls[0].answer({ ok: false, reason: "gone" });
    await vi.advanceTimersByTimeAsync(0);
    expect(s).toMatchObject({ state: "gone", owed: false, unsent: { title: "Typed into a deleted note" } });
  });

  it("dispose stops saving", async () => {
    const m = manualSave();
    const s = new NoteSaver(ID, "v0", m.save, events());
    s.edit({ title: "A" });
    s.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(m.calls).toHaveLength(0);
  });
});
