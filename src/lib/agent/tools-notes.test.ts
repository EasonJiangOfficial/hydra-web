// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/planning/actions", () => ({}));
vi.mock("@/lib/bank/actions", () => ({}));
vi.mock("@/lib/rules/actions", () => ({}));
vi.mock("@/lib/ugc/actions", () => ({}));
vi.mock("@/lib/layout/actions", () => ({}));

const { executeTool, toolByName } = await import("./tools");
const { gateFor } = await import("./registry");
const { memoryStore } = await import("./testing");
const { toolCtx } = await import("./fixtures");
const { memoryNotesDb } = await import("@/lib/notes/testing");

const THREAD = "00000000-0000-4000-8000-0000000000f1";

describe("agent note tools", () => {
  let mem: ReturnType<typeof memoryStore>;
  let notes: ReturnType<typeof memoryNotesDb>;
  const ctx = (over: object = {}) => toolCtx(mem.store, { db: notes.db, threadId: THREAD, ...over });
  beforeEach(() => {
    mem = memoryStore();
    notes = memoryNotesDb();
  });

  it("are in the memory group: every live surface, MCP and a routine with Hydra data", () => {
    for (const name of ["create_note", "search_notes", "read_note", "update_note", "delete_note"]) expect(toolByName(name)?.group, name).toBe("memory");
    expect(toolByName("navigate")?.description).toContain("/notes");
  });

  it("create_note makes blocks from the text, names the note, and logs its undo", async () => {
    const res = await executeTool("create_note", { title: "Groceries", text: "- oat milk\n- eggs" }, ctx());
    expect(res).toMatchObject({ status: "ok", summary: 'Added note "Groceries"' });
    const row = notes.rows[0];
    expect(row).toMatchObject({ title: "Groceries", text: "- oat milk\n- eggs", source: "agent", thread_id: THREAD });
    expect(row.doc.map((b) => b.type)).toEqual(["bulletListItem", "bulletListItem"]);
    expect(mem.actions.at(-1)?.inverse).toEqual({ tool: "delete_note", input: { id: row.id } });
    // No title: the summary names it by its first line. A routine's note says so.
    expect((await executeTool("create_note", { text: "Call Sam about the deal" }, ctx({ surface: "routine" }))).status === "ok" && mem.actions.at(-1)?.summary).toBe(
      'Added note "Call Sam about the deal"',
    );
    expect(notes.rows[1].source).toBe("routine");
  });

  it("search_notes finds by word prefix; read_note gives the text, not the block JSON", async () => {
    await executeTool("create_note", { title: "Groceries", text: "oat milk" }, ctx());
    await executeTool("create_note", { title: "Trip", text: "passport" }, ctx());
    const found = await executeTool("search_notes", { query: "oat" }, ctx());
    expect(found.status === "ok" && (found.data as { title: string }[]).map((n) => n.title)).toEqual(["Groceries"]);
    const read = await executeTool("read_note", { id: notes.rows[1].id }, ctx());
    expect(read).toMatchObject({ status: "ok", summary: 'Read note "Trip"', data: { title: "Trip", text: "passport" } });
    expect(read.status === "ok" && read.data).not.toHaveProperty("doc");
    expect(await executeTool("read_note", { id: "00000000-0000-4000-8000-000000000099" }, ctx())).toEqual({ status: "error", message: "That note is gone." });
  });

  it("update_note appends lines as blocks, replaces text, renames and pins, each summary naming the note", async () => {
    await executeTool("create_note", { title: "Trip", text: "# Packing\n- passport" }, ctx());
    const id = notes.rows[0].id;
    const keep = notes.rows[0].doc[0];
    expect((await executeTool("update_note", { id, text: "[ ] socks", mode: "append" }, ctx())).status === "ok" && mem.actions.at(-1)?.summary).toBe('Added to note "Trip"');
    expect(notes.rows[0].doc[0]).toEqual(keep);
    expect(notes.rows[0].text).toBe("# Packing\n- passport\n[ ] socks");
    const before = structuredClone(notes.rows[0].doc.slice(0, 2));
    expect(mem.actions.at(-1)?.inverse).toEqual({ tool: "update_note", input: { id, title: "Trip", doc: before, pinned: false } });
    // The inverse puts back the exact blocks.
    const inv = mem.actions.at(-1)!.inverse!;
    expect((await executeTool(inv.tool, inv.input, ctx())).status).toBe("ok");
    expect(notes.rows[0].doc).toEqual(before);

    await executeTool("update_note", { id, text: "just this" }, ctx());
    expect(notes.rows[0].text).toBe("just this");
    await executeTool("update_note", { id, title: "Lisbon trip" }, ctx());
    expect(mem.actions.at(-1)?.summary).toBe('Renamed note "Lisbon trip"');
    await executeTool("update_note", { id, pinned: true }, ctx());
    expect(mem.actions.at(-1)?.summary).toBe('Pinned note "Lisbon trip"');
    expect(notes.rows[0].pinned).toBe(true);
    expect(await executeTool("update_note", { id }, ctx())).toEqual({ status: "error", message: "Nothing to change." });
  });

  it("update_note never overwrites an edit made in the page meanwhile", async () => {
    await executeTool("create_note", { title: "Plan", text: "v1" }, ctx());
    const row = notes.rows[0];
    // The owner saves in the page between the tool's read and its write.
    const racing = {
      from: (t: string) => {
        const b = notes.db.from(t) as unknown as { update: (v: object) => unknown };
        const update = b.update;
        b.update = (v: object) => ((row.updated_at = "2026-11-22T12:00:00.000Z"), (row.text = "page edit"), update(v));
        return b;
      },
    } as unknown as SupabaseClient;
    const res = await executeTool("update_note", { id: row.id, text: "agent edit" }, ctx({ db: racing }));
    expect(res).toEqual({ status: "error", message: "The note changed while Hydra was editing it. Read it again first." });
    expect(row.text).toBe("page edit");
  });

  it("delete_note always asks, naming the note; the approved call deletes it with an undo", async () => {
    await executeTool("create_note", { title: "", text: "Call Sam" }, ctx());
    const id = notes.rows[0].id;
    const doc = structuredClone(notes.rows[0].doc);
    const gate = await gateFor(toolByName("delete_note")!, ctx(), { id });
    expect(gate).toEqual({ reason: "delete", summary: 'Delete note "Call Sam"', danger: true });
    expect(await executeTool("delete_note", { id }, ctx())).toMatchObject({ status: "confirm" });
    expect(notes.rows).toHaveLength(1);
    const res = await executeTool("delete_note", { id }, ctx(), { approved: true });
    expect(res).toMatchObject({ status: "ok", summary: 'Deleted note "Call Sam"' });
    expect(notes.rows).toHaveLength(0);
    expect(mem.actions.at(-1)?.inverse).toEqual({ tool: "create_note", input: { title: "", doc } });
    expect(await executeTool("delete_note", { id }, ctx(), { approved: true })).toEqual({ status: "error", message: "That note is gone." });
  });
});
