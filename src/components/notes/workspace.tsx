"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { Pin, Plus, Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { offerUndo } from "@/components/activity/undo-bar";
import { Button } from "@/components/kit";
import { Skeleton } from "@/components/kit/skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { guardLeave } from "@/lib/leave-guard";
import { noteName } from "@/lib/notes/doc";

import { keyInto, NoteEditor } from "./note-editor";
import { NoteSaver } from "./saver";
import type { NoteFull, NoteListItem, NotesActions, TypedEarly } from "./types";

export const NOTE_PARAM = "note";

const SOURCE_LABEL: Partial<Record<NoteListItem["source"], string>> = { desktop: "Mac", phone: "Phone", agent: "Hydra", routine: "Routine", mcp: "MCP" };

/** Pinned first, then the newest change. */
const sorted = (list: NoteListItem[]) =>
  [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at));

const nameOf = (n: NoteListItem) => noteName({ title: n.title, text: n.preview });

/** The note as this page has it: the server's copy with the edits not saved yet shown over it. */
function withUnsent(n: NoteFull, s: NoteSaver): NoteFull {
  const { title, doc } = s.unsent;
  return title === undefined && doc === undefined ? n : { ...n, title: title ?? n.title, doc: doc ?? n.doc, updated_at: s.version };
}

/**
 * The autosaves of one set of actions (the live page's are one per page load): one per note, kept past the
 * page, so a Notes page opened again finds a save still on its way instead of starting a second one.
 */
type Hub = { savers: Map<string, NoteSaver>; saved?: (n: NoteListItem) => void; unguard?: () => void };
const hubs = new WeakMap<NotesActions, Hub>();
function hubOf(actions: NotesActions): Hub {
  let h = hubs.get(actions);
  if (!h) hubs.set(actions, (h = { savers: new Map() }));
  return h;
}

/** Some note has an edit the server has not confirmed. */
const owes = (h: Hub) => [...h.savers.values()].some((s) => s.owed);

/**
 * On while any edit is unsent, on the Notes page or not (the owner went elsewhere in the app, the idle lock
 * hid the page): hiding the tab saves now, with keepalive (it lands even if the page goes); back online
 * retries at once; closing or reloading the tab warns. Off once every edit has landed.
 */
function guard(h: Hub) {
  if (!owes(h)) {
    // Off only once the state settles: a save says "saving" just before it is on its way.
    queueMicrotask(() => {
      if (owes(h) || !h.unguard) return;
      h.unguard();
      h.unguard = undefined;
    });
    return;
  }
  if (h.unguard) return;
  const hide = () => h.savers.forEach((s) => void s.flush({ keepalive: true }));
  const hidden = () => document.visibilityState === "hidden" && hide();
  const online = () => h.savers.forEach((s) => void s.flush());
  const unload = (e: BeforeUnloadEvent) => {
    if (!owes(h)) return;
    e.preventDefault();
    e.returnValue = ""; // older browsers show the warning only with this
  };
  document.addEventListener("visibilitychange", hidden);
  window.addEventListener("pagehide", hide);
  window.addEventListener("online", online);
  window.addEventListener("beforeunload", unload);
  h.unguard = () => {
    document.removeEventListener("visibilitychange", hidden);
    window.removeEventListener("pagehide", hide);
    window.removeEventListener("online", online);
    window.removeEventListener("beforeunload", unload);
  };
}

function ago(iso: string) {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? "" : formatDistanceToNowStrict(t, { addSuffix: true });
}

/** Moves ?note= without a server round trip (Next folds pushState into the router). */
function useNoteUrl() {
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params.get(NOTE_PARAM);
  const go = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (id) next.set(NOTE_PARAM, id);
      else next.delete(NOTE_PARAM);
      const qs = next.toString();
      window.history.pushState(null, "", qs ? `${pathname}?${qs}` : pathname);
    },
    [params, pathname],
  );
  return [selected, go] as const;
}

function NoteRow({ note, active, onOpen }: { note: NoteListItem; active: boolean; onOpen: () => void }) {
  const source = SOURCE_LABEL[note.source];
  return (
    <li>
      <button
        type="button"
        data-testid="note-row"
        aria-current={active ? "true" : undefined}
        onClick={onOpen}
        className={`group/row flex w-full flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left transition-colors duration-200 hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink ${active ? "bg-tint" : ""}`}
      >
        <span className="flex items-center gap-1.5">
          <span className={`min-w-0 flex-1 truncate text-body font-medium ${note.title.trim() ? "text-ink" : "text-ink-3"}`}>{note.title.trim() || "Untitled"}</span>
          {/* The source and time show on hover, over the pin: no row moves. */}
          <span
            suppressHydrationWarning
            className="flex-none text-tag text-ink-3 opacity-0 transition-opacity duration-200 group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
          >
            {source ? `${source} · ` : ""}
            {ago(note.updated_at)}
          </span>
          {note.pinned && (
            <Pin aria-label="Pinned" strokeWidth={1.5} className="size-3.5 flex-none text-ink-3 transition-opacity duration-200 group-hover/row:hidden group-focus-visible/row:hidden" />
          )}
        </span>
        <span className="truncate text-label text-ink-3">{note.preview || " "}</span>
      </button>
    </li>
  );
}

/**
 * The Notes page: the list (search, New note, pinned first then newest) and the open note (`?note=`) with
 * its block editor and autosave. Desktop shows both side by side; the phone shows the list, and a note
 * full screen with a back button. Holds no data of its own: the live page passes server data and actions,
 * /dev/notes passes memory ones. Render inside a Suspense boundary (it reads the search params).
 */
export function NotesWorkspace({
  notes,
  initialOpen,
  actions,
  onRestored,
}: {
  notes: NoteListItem[];
  initialOpen: NoteFull | null;
  actions: NotesActions;
  /** After the undo bar brings a deleted note back (the live page refreshes its list). */
  onRestored?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState(() => sorted(notes));
  const [selected, go] = useNoteUrl();
  /** One autosave per note opened, kept past the editor and the page until its edits land: leaving a note never drops an edit still saving. */
  const hub = hubOf(actions);
  const savers = hub.savers;

  function saverFor(n: NoteFull) {
    let s = savers.get(n.id);
    if (!s) {
      s = new NoteSaver(n.id, n.updated_at, actions.save, { saved: (x) => hub.saved?.(x), change: () => guard(hub) });
      savers.set(n.id, s);
    }
    return s;
  }
  /**
   * A note just read, as this page shows it: its saver's unsent edits over it. A saver with nothing left to
   * save on an older copy (changed elsewhere since), or for a note deleted elsewhere, starts over on this one.
   */
  function withSaver(n: NoteFull): NoteFull {
    const kept = savers.get(n.id);
    if (kept && (kept.state === "gone" || (!kept.dirty && n.updated_at !== kept.version))) dropSaver(n.id);
    return withUnsent(n, saverFor(n));
  }
  /** Stops a note's saver and forgets its unsent edits (deleted here, or the owner took the server's copy). */
  function dropSaver(id: string) {
    savers.get(id)?.dispose();
    savers.delete(id);
    guard(hub);
  }

  // The Notes page opened again (in this tab): the note shows the edits its saver still holds.
  const [open, setOpen] = useState<NoteFull | null>(() => initialOpen && withSaver(initialOpen));
  /** The note the URL names could not be shown: gone, or not read (offline; Try again reads it again). */
  const [missing, setMissing] = useState<{ id: string; failed: boolean } | null>(null);
  const [tries, setTries] = useState(0);
  const [reloads, setReloads] = useState(0);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Set<string> | null>(null);
  const [asking, setAsking] = useState<NoteListItem | null>(null);
  const [busy, setBusy] = useState(false);
  /** The note just made: its title takes the first keys. */
  const [fresh, setFresh] = useState<string | null>(null);
  /** New note failed: says so, with Try again, until a note is made or it is dismissed. */
  const [notMade, setNotMade] = useState(false);
  /** Leaving Notes in the app while an edit is unsent (a link, Back, the agent): where to, once the owner says leave. */
  const [leaving, setLeaving] = useState<{ href: string; key?: string } | null>(null);
  /** Set just before a Leave replays a Back or Forward, so the guard lets that step through. */
  const letGo = useRef(false);
  /** New note is on its way: the keys typed meanwhile, for its title (and, after an Enter, its text). */
  const making = useRef<(TypedEarly & { stop: () => void }) | null>(null);

  // A server refresh (an undo brought a note back) replaces the list.
  const [given, setGiven] = useState(notes);
  if (given !== notes) {
    setGiven(notes);
    setItems(sorted(notes));
  }

  // Back to the list (the phone): the next visit reads the note again, so it shows what was saved since.
  if (!selected && open) setOpen(null);

  // Leaving Notes in the app while an edit is unsent asks first: a link, Back or Forward, the agent. (Closing the
  // tab warns from the hub's guards, which stay on after this page goes.)
  useEffect(() => {
    const away = (to: URL) => to.origin === window.location.origin && to.pathname !== pathname && owes(hub);
    const ask = (to: URL, key?: string) => setLeaving({ href: `${to.pathname}${to.search}${to.hash}`, key });
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const to = new URL(a.href, window.location.href);
      if (!away(to)) return;
      // On the window, before React's handlers on the document (Next's router, the shell's nav mark): the page
      // stays, and looks it, until the owner says leave.
      e.preventDefault();
      e.stopPropagation();
      ask(to);
    };
    // Back or Forward: the Navigation API's navigate event comes before the step, and can stop it (popstate comes
    // after, too late). A browser without it takes the step; the hub's guards still keep the edit.
    const traverse = (ev: Event) => {
      const e = ev as Event & { navigationType: string; destination: { url: string; key: string } }; // no TypeScript lib types yet
      if (e.navigationType !== "traverse") return;
      if (letGo.current) {
        letGo.current = false;
        return;
      }
      if (!e.cancelable) return;
      const to = new URL(e.destination.url);
      if (!away(to)) return;
      e.preventDefault();
      // The step's own history entry: Leave goes there, so history stays as it was (a push would add an entry).
      ask(to, e.destination.key);
    };
    const nav = (window as { navigation?: EventTarget }).navigation;
    window.addEventListener("click", click, true);
    nav?.addEventListener("navigate", traverse);
    const unguard = guardLeave((href) => {
      const to = new URL(href, window.location.href);
      if (!away(to)) return true;
      ask(to);
      return false;
    });
    return () => {
      window.removeEventListener("click", click, true);
      nav?.removeEventListener("navigate", traverse);
      unguard();
    };
  }, [hub, pathname]);

  // Fetch the editor's code with the page, so a new note's editor is there for the first keys.
  useEffect(() => void import("./block-editor"), []);

  // Desktop with no note named: open the top one, so the right side is never empty (the phone shows the list).
  useEffect(() => {
    if (selected || !items.length || !window.matchMedia("(min-width: 768px)").matches) return;
    const qs = new URLSearchParams(window.location.search);
    qs.set(NOTE_PARAM, items[0].id);
    window.history.replaceState(null, "", `${window.location.pathname}?${qs}`);
  }, [selected, items]);

  // Open the note the URL names. A save still on its way lands first, so the copy read back has it. Typing
  // the server does not have yet (a save failing, or a conflict) is shown over it, and its saver carries on.
  // A read that fails (offline) changes nothing: the saver keeps the edit and retries.
  useEffect(() => {
    if (!selected || open?.id === selected) return;
    let live = true;
    void (async () => {
      await savers.get(selected)?.flush();
      const n = await actions.open(selected);
      if (!live) return;
      if (n === "failed") {
        setOpen(null); // the next visit reads it again, not a copy from before
        setMissing({ id: selected, failed: true });
        return;
      }
      if (!n) dropSaver(selected);
      setOpen(n && withSaver(n));
      setMissing(n ? null : { id: selected, failed: false });
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dropSaver and withSaver only touch the stable map
  }, [selected, open?.id, actions, savers, tries]);

  // Search as the owner types, a beat after the last key.
  useEffect(() => {
    const words = query.trim();
    if (!words) return;
    const t = setTimeout(() => void actions.search(words).then((ids) => ids && setMatches(new Set(ids))), 200);
    return () => clearTimeout(t);
  }, [query, actions]);

  const searching = query.trim() !== "";
  const hits = useMemo(() => (searching && matches ? items.filter((n) => matches.has(n.id)) : items), [items, matches, searching]);
  const current = open && open.id === selected ? open : null;
  const row = current ? items.find((n) => n.id === current.id) : undefined;

  const patchItem = useCallback((id: string, patch: Partial<NoteListItem>) => setItems((list) => sorted(list.map((n) => (n.id === id ? { ...n, ...patch } : n)))), []);

  // The saves land in this page's list.
  hub.saved = (x) => patchItem(x.id, x);

  /** The keys typed so far while New note is on its way; stops collecting them. */
  const takeTyped = useCallback((): TypedEarly | null => {
    const m = making.current;
    if (!m) return null;
    making.current = null;
    m.stop();
    return { title: m.title, body: m.body };
  }, []);

  async function create() {
    // One at a time: a key on the button while the note is made does not make another.
    if (making.current) return;
    // Until the title shows, keys are kept for it instead of pressing New note again.
    (document.activeElement as HTMLElement | null)?.blur();
    const m: TypedEarly & { stop: () => void } = { title: "", body: null, stop: () => window.removeEventListener("keydown", keep, true) };
    // The title takes the keys up to an Enter; the ones after it are the text's.
    function keep(e: KeyboardEvent) {
      if (m.body === null && e.key === "Enter" && !e.isComposing) m.body = "";
      else {
        const next = keyInto(m.body ?? m.title, e);
        if (next === null) return;
        if (m.body === null) m.title = next;
        else m.body = next;
      }
      e.preventDefault();
    }
    window.addEventListener("keydown", keep, true);
    making.current = m;
    const n = await actions.create();
    if (!n) {
      // Not made (offline, the server down): the keys typed for it go, so none end up in the next note.
      takeTyped();
      setNotMade(true);
      return;
    }
    setNotMade(false);
    saverFor(n);
    setItems((list) => sorted([n, ...list]));
    setOpen(n);
    setQuery("");
    setFresh(n.id);
    go(n.id);
  }

  /** New note's buttons. The second click of a double click neither makes a second note nor takes the focus from its title. */
  const newNote = {
    onMouseDown: (e: React.MouseEvent) => {
      if (e.detail > 1) e.preventDefault();
    },
    onClick: (e: React.MouseEvent) => {
      if (e.detail < 2) void create();
    },
  };

  async function pin(n: NoteListItem) {
    patchItem(n.id, { pinned: !n.pinned });
    if (!(await actions.pin(n.id, !n.pinned))) patchItem(n.id, { pinned: n.pinned });
  }

  async function remove(n: NoteListItem) {
    setBusy(true);
    const r = await actions.remove(n.id);
    setBusy(false);
    if (!r.ok) return;
    setAsking(null);
    dropSaver(n.id);
    setItems((list) => list.filter((x) => x.id !== n.id));
    setOpen(null);
    go(null);
    offerUndo(r.activityId, `note "${nameOf(n)}"`, onRestored);
  }

  async function reload() {
    if (!current) return;
    const n = await actions.open(current.id);
    if (n === "failed") return; // offline: the local copy stays, and Reload works once the server answers
    dropSaver(current.id); // the owner takes the note as saved elsewhere over the local copy
    setOpen(n);
    if (n) patchItem(n.id, n);
    else setMissing({ id: current.id, failed: false });
    setReloads((x) => x + 1);
  }

  return (
    <div className="flex flex-col gap-5">
      <div className={selected ? "max-md:hidden" : undefined}>
        <PageHeader title="Notes" />
      </div>
      <div className="grid overflow-hidden md:h-[calc(100dvh-108px)] md:grid-cols-[288px_minmax(0,1fr)] md:rounded-xl md:border md:border-rule md:bg-surface">
        <section aria-label="All notes" className={`flex min-h-0 min-w-0 flex-col md:border-r md:border-rule ${selected ? "max-md:hidden" : ""}`}>
          <div className="flex flex-none items-center gap-2 pb-3 md:p-3">
            <label className="relative flex-1">
              <span className="sr-only">Search notes</span>
              <Search aria-hidden strokeWidth={1.5} className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-3" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                className="h-[34px] w-full rounded-lg border border-rule-2 bg-surface pr-3 pl-8 text-body text-ink outline-none transition-colors duration-200 placeholder:text-ink-3 focus:border-ink [&::-webkit-search-cancel-button]:appearance-none"
              />
            </label>
            <Button variant="primary" {...newNote}>
              <Plus aria-hidden strokeWidth={1.5} />
              New note
            </Button>
          </div>
          {notMade && (
            <div role="alert" className="mb-3 flex flex-none items-center gap-1 rounded-lg bg-tint py-1 pr-1 pl-3 text-label text-ink-2 md:mx-2">
              <span className="min-w-0 flex-1 truncate">Couldn&rsquo;t make the note</span>
              <Button variant="ghost" className="h-8 px-2 text-label" {...newNote}>
                Try again
              </Button>
              <Button variant="ghost" size="icon-sm" className="size-8" aria-label="Dismiss" onClick={() => setNotMade(false)}>
                <X aria-hidden strokeWidth={1.5} />
              </Button>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto md:px-2 md:pb-2">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-body text-ink-3">No notes yet.</p>
            ) : (
              <>
                {hits.length === 0 ? (
                  <p className="px-3 py-6 text-body text-ink-3">No notes match &ldquo;{query.trim()}&rdquo;</p>
                ) : (
                  <ul className="flex flex-col gap-px max-md:rounded-xl max-md:border max-md:border-rule max-md:p-1.5">
                    {hits.map((n) => (
                      <NoteRow key={n.id} note={n} active={n.id === selected} onOpen={() => go(n.id)} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </section>
        <section aria-label="Note" className={`min-h-0 md:overflow-y-auto ${selected ? "" : "max-md:hidden"}`}>
          {current && row ? (
            <NoteEditor
              key={`${current.id}:${reloads}`}
              note={{ ...current, pinned: row.pinned }}
              saver={saverFor(current)}
              autoFocus={current.id === fresh}
              takeTyped={current.id === fresh ? takeTyped : undefined}
              onTitle={(title) => patchItem(current.id, { title })}
              onReload={() => void reload()}
              onBack={() => go(null)}
              onPin={() => void pin(row)}
              onDelete={() => setAsking(row)}
            />
          ) : selected && missing?.id === selected ? (
            <div className="flex flex-col items-start gap-3 p-6 max-md:px-0">
              <p className="text-body text-ink-3">{missing.failed ? "Could not open this note." : "That note is gone."}</p>
              <div className="-ml-2.5 flex gap-1">
                {missing.failed && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setMissing(null);
                      setTries((x) => x + 1);
                    }}
                  >
                    Try again
                  </Button>
                )}
                <Button variant="ghost" className="md:hidden" onClick={() => go(null)}>
                  Back to notes
                </Button>
              </div>
            </div>
          ) : selected ? (
            <div aria-hidden className="flex flex-col gap-3 px-12 pt-[72px] max-md:px-0">
              <Skeleton className="h-7 w-56" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center p-6 max-md:hidden">
              <Button variant="ghost" className="text-ink-3" {...newNote}>
                <Plus aria-hidden strokeWidth={1.5} />
                Start a note
              </Button>
            </div>
          )}
        </section>
      </div>
      <Dialog open={leaving !== null} onOpenChange={(o) => !o && setLeaving(null)}>
        <DialogContent showCloseButton={false} className="gap-5 p-5 text-body">
          <DialogTitle className="text-section">Changes not saved yet. Leave anyway?</DialogTitle>
          <DialogDescription className="sr-only">Notes keeps trying to save them while this tab is open.</DialogDescription>
          <DialogFooter className="-mx-5 -mb-5 border-t-0 bg-transparent px-5 pt-0 pb-5">
            <Button variant="ghost" onClick={() => setLeaving(null)}>
              Stay
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const nav = (window as { navigation?: { traverseTo: (key: string) => unknown } }).navigation;
                if (leaving?.key && nav) {
                  letGo.current = true;
                  nav.traverseTo(leaving.key);
                } else if (leaving) router.push(leaving.href);
                setLeaving(null);
              }}
            >
              Leave
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={asking !== null} onOpenChange={(o) => !o && setAsking(null)}>
        <DialogContent showCloseButton={false} className="gap-5 p-5 text-body">
          <DialogTitle className="text-section">Delete &ldquo;{asking ? nameOf(asking) : ""}&rdquo;?</DialogTitle>
          <DialogDescription className="sr-only">You can undo this from Activity for 30 days.</DialogDescription>
          <DialogFooter className="-mx-5 -mb-5 border-t-0 bg-transparent px-5 pt-0 pb-5">
            <Button variant="ghost" onClick={() => setAsking(null)}>
              Keep it
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => asking && void remove(asking)}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
