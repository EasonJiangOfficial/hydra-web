import { z } from "zod";
import { docSchema, noteName, textToDoc, TITLE_MAX, type NoteSource } from "@/lib/notes/doc";
import { createNote, deleteNote, getNote, listNotes, updateNote } from "@/lib/notes/queries";
import { defineTool, ToolError, uuid, type ToolCtx, type ToolDef } from "./registry";
import { namedDelete, q, rowOf } from "./tools-confirm";

/**
 * Notes (the /notes page): the agent makes, finds, reads, changes and deletes the owner's notes
 * through the same queries the page calls. Group "memory": every live surface, MCP and a routine
 * with Hydra data. Notes are not memory facts: they are never put in the prompt.
 */

const title = z.string().max(TITLE_MAX);
const text = z.string().max(20_000);
/** The exact block document: undo puts a note back with it (plain text would lose links, styles, tables). */
const doc = docSchema.describe("Leave out: undo uses it to restore the exact blocks.");

/** Where an agent-made note came from: a routine or MCP by name, any live turn as the agent. */
const sourceOf = (ctx: ToolCtx): NoteSource => (ctx.surface === "routine" || ctx.surface === "mcp" ? ctx.surface : "agent");

const named = (n: { title: string; text: string }) => q(noteName(n));

export const NOTE_TOOLS: ToolDef[] = [
  defineTool({
    name: "create_note",
    description:
      "Add a note to the Notes page. text is plain lines; # heading, - bullet, 1. numbered, [ ] to-do, > quote and --- divider lines become those blocks.",
    group: "memory",
    kind: "write",
    input: z.object({ title: title.optional(), text: text.optional(), doc: doc.optional() }),
    run: async (ctx, input) => {
      if (input.text === undefined && input.doc === undefined) throw new ToolError("Send the note's text.");
      const { note } = await createNote(ctx.db, { title: input.title, text: input.text, doc: input.doc, source: sourceOf(ctx), threadId: ctx.threadId, deviceId: ctx.deviceId });
      return { data: { id: note.id, title: note.title }, summary: `Added note ${named(note)}`, inverse: { tool: "delete_note", input: { id: note.id } } };
    },
  }),
  defineTool({
    name: "search_notes",
    description: "Find notes by words in the title or text (prefix match), pinned first then newest; no query lists the newest.",
    group: "memory",
    kind: "read",
    input: z.object({ query: z.string().max(200).optional(), limit: z.int().min(1).max(50).optional() }),
    run: async (ctx, { query, limit }) => {
      const notes = await listNotes(ctx.db, { query, limit: limit ?? 20 });
      return { data: notes, summary: query ? `Searched notes for "${query.slice(0, 40)}"` : "Read notes" };
    },
  }),
  defineTool({
    name: "read_note",
    description: "One note's title and full text by id (from search_notes).",
    group: "memory",
    kind: "read",
    input: z.object({ id: uuid }),
    run: async (ctx, { id }) => {
      const note = await getNote(ctx.db, id);
      if (!note) throw new ToolError("That note is gone.");
      const { id: noteId, title: t, text: body, pinned, source, created_at, updated_at } = note;
      return { data: { id: noteId, title: t, text: body, pinned, source, created_at, updated_at }, summary: `Read note ${named(note)}` };
    },
  }),
  defineTool({
    name: "update_note",
    description: "Change a note: rename it, replace its text or append lines to it (mode, default replace), or pin it to the top of the list.",
    group: "memory",
    kind: "write",
    input: z.object({
      id: uuid,
      title: title.optional(),
      text: text.optional(),
      mode: z.enum(["replace", "append"]).optional(),
      pinned: z.boolean().optional(),
      doc: doc.optional(),
    }),
    run: async (ctx, { id, title: newTitle, text: newText, mode, pinned, doc: exact }) => {
      if (newTitle === undefined && newText === undefined && pinned === undefined && exact === undefined) throw new ToolError("Nothing to change.");
      const before = await getNote(ctx.db, id);
      if (!before) throw new ToolError("That note is gone.");
      const doc = exact ?? (newText === undefined ? undefined : mode === "append" ? [...before.doc, ...textToDoc(newText)] : textToDoc(newText));
      // Compare-and-set on the copy just read: an edit in the page meanwhile is never overwritten.
      const r = await updateNote(ctx.db, id, { title: newTitle, doc, pinned }, before.updated_at);
      if (!r.ok) throw new ToolError(r.reason === "gone" ? "That note is gone." : "The note changed while Hydra was editing it. Read it again first.");
      const verb = doc ? (mode === "append" ? "Added to" : "Changed") : newTitle !== undefined ? "Renamed" : pinned ? "Pinned" : "Unpinned";
      return {
        data: { id, title: r.note.title, updated_at: r.note.updated_at },
        summary: `${verb} note ${named(r.note)}`,
        inverse: { tool: "update_note", input: { id, title: before.title, ...(doc ? { doc: before.doc } : {}), pinned: before.pinned } },
      };
    },
  }),
  defineTool({
    name: "delete_note",
    description: "Delete a note.",
    group: "memory",
    kind: "write",
    risk: "delete",
    describe: () => "Delete this note",
    gate: namedDelete("Delete this note", async (ctx, { id }: { id: string }) => {
      const n = await rowOf<{ title: string; text: string }>(ctx, "notes", id, "title, text");
      return n && `Delete note ${named(n)}`;
    }),
    input: z.object({ id: uuid }),
    run: async (ctx, { id }) => {
      const before = await deleteNote(ctx.db, id);
      if (!before) throw new ToolError("That note is gone.");
      return {
        data: { id },
        summary: `Deleted note ${named(before)}`,
        inverse: { tool: "create_note", input: { title: before.title, doc: before.doc } },
      };
    },
  }),
];
