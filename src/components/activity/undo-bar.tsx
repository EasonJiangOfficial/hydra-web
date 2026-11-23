"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { undoActivities, undoActivity } from "@/lib/activity/actions";
import type { UndoResult } from "@/lib/activity/types";

/**
 * What was just deleted: the activity to undo and a short name, e.g. `task "Film 6 videos"`. `more` are
 * other activities of the same delete (one per server call), undone with it in one transaction. `onUndone`
 * puts the row back in a page's client store; the server render comes back by itself (router.refresh).
 */
export type UndoItem = { activityId: string; thing: string; more?: string[]; onUndone?: () => void; verb?: string };

export type UndoBarProps = {
  /** One at a time: a new item replaces the one showing and restarts the clock. Null hides the bar. */
  item: UndoItem | null;
  onClose: () => void;
  /** Defaults to the real `undoActivity`; fixtures pass their own. */
  undo?: (id: string, opts: { force?: boolean }) => Promise<UndoResult>;
  /**
   * A delete made of several calls (`more`), undone in one transaction: all come back or none. Defaults to
   * the real `undoActivities`; a fixture that passes `undo` alone gets them undone one by one.
   */
  undoMany?: (ids: string[], opts: { force?: boolean }) => Promise<UndoResult>;
};

export const UNDO_BAR_MS = 8000;

/**
 * "Deleted <thing>. Undo" at the bottom of the page for 8 s after a page delete (DESIGN.md section 7: ink, no
 * explanatory sentence). On the phone it sits above the tabs and the agent orb. The clock stops while the pointer or focus is on it. Esc closes it. On undo the page refreshes.
 */
export function UndoBar({ item, onClose, undo, undoMany }: UndoBarProps) {
  const router = useRouter();
  const [held, setHeld] = useState({ id: "", hover: false, focus: false });
  const close = useRef(onClose);
  // The item showing now: an undo that ends after a newer delete opened the bar must not close that one.
  const showing = useRef(item);
  useEffect(() => {
    close.current = onClose;
    showing.current = item;
  });
  // The last item stays drawn for its exit (DESIGN.md section 7: exit faster than the enter).
  const [shown, setShown] = useState(item);
  const [prev, setPrev] = useState(item);
  if (item !== prev) {
    setPrev(item);
    if (item) setShown(item);
  }
  const leaving = !item && shown ? shown : null;
  const [state, setState] = useState<{ id: string; s: "busy" | "failed" } | null>(null);
  const id = item?.activityId;
  const status = state && state.id === id ? state.s : "idle";
  const paused = (held.id === id && (held.hover || held.focus)) || status !== "idle";
  const hold = (p: { hover?: boolean; focus?: boolean }) =>
    setHeld((h) => ({ ...(h.id === id ? h : { hover: false, focus: false }), ...p, id: id ?? "" }));

  // ponytail: the clock restarts from 8 s after a hover or focus ends, not from what was left.
  useEffect(() => {
    if (!id || paused) return;
    const t = setTimeout(() => close.current(), UNDO_BAR_MS);
    return () => clearTimeout(t);
  }, [id, paused]);

  async function run() {
    if (!id || !item) return;
    const undone = item;
    setState({ id, s: "busy" });
    const ids = [id, ...(undone.more ?? [])];
    let r: UndoResult = { ok: false, error: "failed" };
    try {
      if (ids.length === 1) r = await (undo ?? undoActivity)(id, {});
      else if (undoMany || !undo) r = await (undoMany ?? undoActivities)(ids, {});
      else {
        // A fixture's one-by-one undo: newest first, the last call of the delete is undone first.
        for (const x of [...ids].reverse()) {
          r = await undo(x, {});
          if (!r.ok) break;
        }
      }
    } catch {
      r = { ok: false, error: "failed" };
    }
    if (!r.ok) return setState({ id, s: "failed" });
    setState(null);
    undone.onUndone?.();
    if (showing.current?.activityId === id) onClose();
    router.refresh();
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(146px+env(safe-area-inset-bottom))] z-[70] flex justify-center px-4 md:bottom-6"
    >
      {leaving && (
        <div
          key={`leaving-${leaving.activityId}`}
          aria-hidden
          data-testid="undo-bar-leaving"
          onAnimationEnd={() => setShown(null)}
          className="flex max-w-[min(560px,100%)] items-center gap-4 rounded-lg bg-ink py-2 pr-2 pl-4 text-body text-white motion-reduce:hidden motion-safe:animate-out motion-safe:fade-out-0 motion-safe:slide-out-to-bottom-2 motion-safe:duration-150 motion-safe:fill-mode-forwards"
        >
          <span className="min-w-0 truncate">{`${leaving.verb ?? "Deleted"} ${leaving.thing}.`}</span>
          <span className={action}>Undo</span>
          <span className="size-7 flex-none" />
        </div>
      )}
      {item && (
        <div
          key={item.activityId}
          data-testid="undo-bar"
          onPointerEnter={() => hold({ hover: true })}
          onPointerLeave={() => hold({ hover: false })}
          onFocus={() => hold({ focus: true })}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) hold({ focus: false });
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          className="pointer-events-auto flex max-w-[min(560px,100%)] items-center gap-4 rounded-lg bg-ink py-2 pr-2 pl-4 text-body text-white motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-200"
        >
          <span className="min-w-0 truncate">{status === "failed" ? "Could not undo." : `${item.verb ?? "Deleted"} ${item.thing}.`}</span>
          {status === "failed" ? (
            <Link href="/activity" className={action}>
              Activity
            </Link>
          ) : (
            <button type="button" onClick={run} disabled={status === "busy"} className={action}>
              {status === "busy" ? "Undoing…" : "Undo"}
            </button>
          )}
          <button type="button" aria-label="Dismiss" onClick={onClose} className="grid size-7 flex-none place-items-center rounded-md text-white/60 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

const action =
  "flex-none rounded-md px-2 py-1 font-medium text-white underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-white disabled:opacity-60";

const hosts = new Set<(item: UndoItem) => void>();

/**
 * After a page delete: show the bar for its activity. `ids` are the activityIds the delete calls
 * returned (null or missing on in-memory fixtures: then no bar shows).
 */
export function offerUndo(
  ids: string | null | undefined | (string | null | undefined)[],
  thing: string,
  onUndone?: () => void,
  /** The bar's first word: "Deleted" unless the action was another one ("Linked", "Unlinked"). */
  verb?: string,
) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((x): x is string => !!x);
  if (!list.length) return;
  const item: UndoItem = { activityId: list[0], more: list.slice(1), thing, onUndone, verb };
  for (const show of hosts) show(item);
}

/** The one bar for the app, mounted once in the (app) layout; `offerUndo` fills it. A fixture passes its own `undo`. */
export function UndoHost({ undo }: { undo?: UndoBarProps["undo"] } = {}) {
  const [item, setItem] = useState<UndoItem | null>(null);
  useEffect(() => {
    hosts.add(setItem);
    return () => void hosts.delete(setItem);
  }, []);
  return <UndoBar item={item} onClose={() => setItem(null)} undo={undo} />;
}
