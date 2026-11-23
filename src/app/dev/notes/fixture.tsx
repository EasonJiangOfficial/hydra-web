"use client";

import { useSearchParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";

import type { NoteFull, NotesActions } from "@/components/notes/types";
import { NotesWorkspace } from "@/components/notes/workspace";
import { docToText, preview, type NoteDoc } from "@/lib/notes/doc";
import { searchQuery } from "@/lib/notes/queries";

const t = (text: string, styles: Record<string, boolean> = {}) => ({ type: "text", text, styles });

/** One of every block the editor makes. */
const EVERY_BLOCK: NoteDoc = [
  { type: "heading", props: { level: 1 }, content: [t("Plan")] },
  { type: "paragraph", content: [t("Flights are "), t("booked", { bold: true }), t(". Hotel: "), { type: "link", href: "https://example.com/hotel", content: [t("Casa do Rio")] }, t(", "), t("check in after 3", { italic: true }), t(".")] },
  { type: "heading", props: { level: 2 }, content: [t("Packing")] },
  { type: "bulletListItem", content: [t("Passport")], children: [{ type: "bulletListItem", content: [t("Copy in the bag")] }] },
  { type: "bulletListItem", content: [t("Chargers")] },
  { type: "heading", props: { level: 3 }, content: [t("Days")] },
  { type: "numberedListItem", content: [t("Alfama and the castle")] },
  { type: "numberedListItem", content: [t("Belém")] },
  { type: "checkListItem", props: { checked: true }, content: [t("Book the airport taxi")] },
  { type: "checkListItem", props: { checked: false }, content: [t("Exchange 200 EUR")] },
  { type: "toggleListItem", content: [t("Restaurant list")], children: [{ type: "paragraph", content: [t("Taberna da Rua das Flores")] }] },
  { type: "quote", content: [t("Travel light, stay longer.")] },
  { type: "codeBlock", props: { language: "text" }, content: [t("Gate B12 · Seat 14A")] },
  { type: "divider" },
  { type: "table", content: { type: "tableContent", rows: [{ cells: [[t("Day")], [t("Budget")]] }, { cells: [[t("Fri")], [t("120 EUR")]] }] } },
  { type: "paragraph", content: [] },
];

const AT = (d: number, h: number) => new Date(Date.UTC(2026, 10, d, h)).toISOString();

function note(id: number, title: string, doc: NoteDoc, at: string, over: Partial<NoteFull> = {}): NoteFull {
  return { id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`, title, preview: preview(docToText(doc), 140, title), source: "web", pinned: false, created_at: at, updated_at: at, doc, ...over };
}

/** A list row: the note without its document. */
const item = (n: NoteFull) => ({ id: n.id, title: n.title, preview: n.preview, source: n.source, pinned: n.pinned, created_at: n.created_at, updated_at: n.updated_at });

const para = (s: string): NoteDoc => s.split("\n").map((line) => ({ type: "paragraph", content: [t(line)] }));

const SEED: NoteFull[] = [
  note(1, "Lisbon trip", EVERY_BLOCK, AT(22, 9), { pinned: true }),
  note(2, "Groceries", [{ type: "bulletListItem", content: [t("Oat milk")] }, { type: "bulletListItem", content: [t("Eggs")] }], AT(22, 8)),
  note(3, "", para("Call Sam about the Glow deal before Friday"), AT(21, 18), { source: "desktop" }),
  note(4, "Video ideas", para("Morning routine in 30 seconds\nDesk tour"), AT(20, 12), { source: "agent" }),
];

/**
 * The Notes workspace on in-memory data, for /dev/notes. ?empty=1 starts with none. ?conflict=1: each note
 * is changed elsewhere just before its first save here. ?offline=1, or the browser offline: every save,
 * read and New note fails as with no network. A reload starts over.
 */
export function NotesFixture() {
  const params = useSearchParams();
  const empty = params.get("empty") === "1";
  // ?conflict=1: another tab or the Mac saves each note once, just before this page's first save of it.
  const [conflict] = useState(() => params.get("conflict") === "1");
  const [offline] = useState(() => params.get("offline") === "1");
  const [elsewhere] = useState(() => new Set<string>());
  const [store] = useState(() => new Map((empty ? [] : SEED).map((n) => [n.id, structuredClone(n)])));
  const next = useRef({ n: 100, clock: Date.UTC(2026, 10, 22, 10) });
  const actions = useMemo<NotesActions>(() => {
    const stamp = () => new Date((next.current.clock += 1000)).toISOString();
    const down = () => offline || !navigator.onLine;
    return {
      open: async (id) => (down() ? "failed" : structuredClone(store.get(id) ?? null)),
      search: async (q) => {
        const terms = (searchQuery(q) ?? "").split(" & ").map((x) => x.replace(/:\*$/, ""));
        const words = (n: NoteFull) => `${n.title} ${docToText(n.doc)}`.toLowerCase().split(/[^\p{L}\p{N}]+/u);
        return [...store.values()].filter((n) => terms.every((x) => words(n).some((w) => w.startsWith(x)))).map((n) => n.id);
      },
      create: async () => {
        if (down()) return new Promise<null>((r) => setTimeout(() => r(null), 300)); // a request that times out
        const at = stamp();
        const n = note(next.current.n++, "", [], at);
        store.set(n.id, n);
        return structuredClone(n);
      },
      save: async (id, patch, expected) => {
        await new Promise((r) => setTimeout(r, 150));
        if (down()) return { ok: false, reason: "failed" };
        const n = store.get(id);
        if (!n) return { ok: false, reason: "gone" };
        if (conflict && !elsewhere.has(id)) {
          elsewhere.add(id);
          n.updated_at = stamp();
        }
        if (n.updated_at !== expected) return { ok: false, reason: "conflict", note: structuredClone(n) };
        Object.assign(n, patch, { updated_at: stamp() });
        n.preview = preview(docToText(n.doc), 140, n.title);
        return { ok: true, note: item(n) };
      },
      pin: async (id, pinned) => {
        const n = store.get(id);
        if (n) n.pinned = pinned;
        return !!n;
      },
      remove: async (id) => ({ ok: store.delete(id), activityId: null }),
    };
  }, [store, conflict, offline, elsewhere]);
  const first = params.get("note");
  const [notes] = useState(() => [...store.values()].map(item));
  const [open] = useState(() => (first && store.get(first)) || null);
  return <NotesWorkspace notes={notes} initialOpen={open} actions={actions} />;
}
