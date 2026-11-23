// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createNote, deleteNote, getNote, listNotes, searchQuery, updateNote } from "./queries";
import { memoryNotesDb } from "./testing";

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 22, 10, 0, tick++)).toISOString();

describe("notes queries", () => {
  it("derives the text from the document on create and on save", async () => {
    const { db } = memoryNotesDb([], clock);
    const { note } = await createNote(db, { title: " Trip ", text: "# Packing\n- passport", source: "agent" });
    expect(note).toMatchObject({ title: "Trip", text: "# Packing\n- passport", source: "agent" });
    expect(note.doc.map((b) => b.type)).toEqual(["heading", "bulletListItem"]);
    const r = await updateNote(db, note.id, { doc: [{ type: "checkListItem", props: { checked: true }, content: [{ type: "text", text: "visa" }] }] });
    expect(r.ok && r.note.text).toBe("[x] visa");
  });

  it("saves no U+0000 (Postgres text and jsonb refuse it) in the title, the document or the text", async () => {
    const { db } = memoryNotesDb([], clock);
    const { note } = await createNote(db, { title: "Tr\0ip", text: "milk\0 and eggs", source: "web" });
    expect(JSON.stringify(note)).not.toContain("\\u0000");
    expect(note).toMatchObject({ title: "Trip", text: "milk and eggs" });
    const r = await updateNote(db, note.id, { title: "A\0", doc: [{ type: "paragraph", content: [{ type: "text", text: "b\0c" }] }] });
    expect(r.ok && [r.note.title, r.note.text, JSON.stringify(r.note.doc).includes("\\u0000")]).toEqual(["A", "bc", false]);
  });

  it("is idempotent on client_id: a retry gives back the first note and adds nothing", async () => {
    const { db, rows } = memoryNotesDb([], clock);
    const first = await createNote(db, { text: "Call Sam", source: "desktop", clientId: "toolu_1:0", deviceId: "d1" });
    const again = await createNote(db, { text: "Call Sam (retry)", source: "desktop", clientId: "toolu_1:0", deviceId: "d1" });
    expect(first.created).toBe(true);
    expect(again).toEqual({ note: first.note, created: false });
    expect(rows).toHaveLength(1);
    // The same client_id from another device is refused, not answered with d1's note.
    await expect(createNote(db, { text: "Other", source: "desktop", clientId: "toolu_1:0", deviceId: "d2" })).rejects.toMatchObject({ code: "client_id_taken" });
    await expect(createNote(db, { text: "Other", source: "web", clientId: "toolu_1:0" })).rejects.toMatchObject({ code: "client_id_taken" });
    expect(rows).toHaveLength(1);
    // Without a client_id every call is a new note.
    await createNote(db, { text: "Call Sam", source: "web" });
    await createNote(db, { text: "Call Sam", source: "web" });
    expect(rows).toHaveLength(3);
  });

  it("saves with compare-and-set: a stale updated_at is a conflict and writes nothing", async () => {
    const { db } = memoryNotesDb([], clock);
    const { note } = await createNote(db, { title: "Plan", text: "v1", source: "web" });
    const mine = await updateNote(db, note.id, { title: "Plan A" }, note.updated_at);
    expect(mine.ok).toBe(true);
    // A second tab still holds the first copy.
    const theirs = await updateNote(db, note.id, { title: "Plan B" }, note.updated_at);
    expect(theirs).toMatchObject({ ok: false, reason: "conflict", note: { title: "Plan A" } });
    expect((await getNote(db, note.id))?.title).toBe("Plan A");
    // Pinning keeps updated_at, so the next save from the same copy still lands.
    const saved = mine.ok ? mine.note.updated_at : "";
    const pin = await updateNote(db, note.id, { pinned: true });
    expect(pin.ok && pin.note.updated_at).toBe(saved);
    expect((await updateNote(db, note.id, { title: "Plan C" }, saved)).ok).toBe(true);
  });

  it("reports a gone note, and delete returns what it removed", async () => {
    const { db } = memoryNotesDb([], clock);
    const { note } = await createNote(db, { title: "Old", text: "x", source: "web" });
    expect((await deleteNote(db, note.id))?.title).toBe("Old");
    expect(await deleteNote(db, note.id)).toBeNull();
    expect(await updateNote(db, note.id, { title: "x" }, note.updated_at)).toEqual({ ok: false, reason: "gone" });
  });

  it("searches by word prefix over title and text; lists carry a preview, not the document", async () => {
    const { db } = memoryNotesDb([], clock);
    await createNote(db, { title: "Groceries", text: "- oat milk\n- eggs", source: "web" });
    await createNote(db, { title: "Trip", text: "passport", source: "web" });
    expect((await listNotes(db, { query: "oat gro" })).map((n) => n.title)).toEqual(["Groceries"]);
    expect(await listNotes(db, { query: "zzz" })).toEqual([]);
    const all = await listNotes(db);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ title: "Groceries", preview: "oat milk" });
    expect(all[0]).not.toHaveProperty("doc");
    expect(all[0]).not.toHaveProperty("text");
  });

  it("keeps only letters and digits in the search query", () => {
    expect(searchQuery("oat mil")).toBe("oat:* & mil:*");
    expect(searchQuery("a' | b:* & !c")).toBe("a:* & b:* & c:*");
    expect(searchQuery("  ")).toBeNull();
    expect(searchQuery("Café 2026")).toBe("café:* & 2026:*");
  });
});
