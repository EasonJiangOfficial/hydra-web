"use client";

import { useEffect, useRef, useState } from "react";

import { Button, Card, InfoDot, Label, Pill, cn } from "@/components/kit";
import { UNDO_DAYS, type ActivityEntry, type ActivityPage, type UndoResult } from "@/lib/activity/types";

import { WHO, WHY_NOT, byDay, dayLabel, timeText } from "./format";

export type ActivityListProps = {
  first: ActivityPage;
  timeZone: string;
  /** ISO; the server's now, so "Today" matches on both sides of hydration. */
  now: string;
  /** Newest first; `before` is the previous page's `next`. */
  load: (opts: { before?: string; limit?: number }) => Promise<ActivityPage>;
  undo: (id: string, opts: { force?: boolean }) => Promise<UndoResult>;
};

type RowState = { busy?: boolean; changed?: string[]; blocked?: boolean; error?: string };

const ERROR: Record<string, string> = { not_found: "Not found.", failed: "Could not undo. Try again." };

/** Activity, newest first, grouped by day. Each row: summary (click for details), who, time, and Undo. */
export function ActivityList({ first, timeZone, now, load, undo }: ActivityListProps) {
  const [entries, setEntries] = useState(first.entries);
  const [next, setNext] = useState(first.next);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [more, setMore] = useState<"idle" | "busy" | "failed">("idle");
  const today = new Date(now);
  // The list as last drawn (with its patches), for reload() after an await.
  const shown = useRef(entries);
  useEffect(() => {
    shown.current = entries;
  });

  const setRow = (id: string, s: RowState) => setRows((r) => ({ ...r, [id]: s }));
  const patch = (id: string, p: Partial<ActivityEntry>) => setEntries((list) => list.map((e) => (e.id === id ? { ...e, ...p } : e)));

  /**
   * Reload the first page, so the undo itself shows at the top, and keep the older entries already on
   * screen below it (with their cursor), however many pages were shown.
   */
  async function reload() {
    const fresh = await load({});
    const ids = new Set(fresh.entries.map((e) => e.id));
    // Which entries stay below the first page: by id (the list may not have redrawn its patches yet).
    const list = shown.current;
    const last = list.reduce((at, e, i) => (ids.has(e.id) ? i : at), -1);
    const rest = new Set(fresh.next && last >= 0 ? list.slice(last + 1).map((e) => e.id) : []);
    setEntries((now) => [...fresh.entries, ...now.filter((e) => rest.has(e.id) && !ids.has(e.id))]);
    setNext(rest.size ? next : fresh.next);
  }

  async function runUndo(id: string, force = false) {
    setRow(id, { busy: true });
    let r: UndoResult;
    try {
      r = await undo(id, { force });
    } catch {
      r = { ok: false, error: "failed" };
    }
    if (r.ok) {
      setRow(id, {});
      patch(id, { undoneAt: new Date().toISOString(), canUndo: false, cannotUndo: "undone" });
      // Undoing an undo redoes the original: it can be undone again (it may sit below the reloaded page).
      const was = shown.current.find((e) => e.id === id)?.undoOf;
      const orig = was ? shown.current.find((e) => e.id === was) : undefined;
      if (orig && today.getTime() - Date.parse(orig.at) <= UNDO_DAYS * 86_400_000)
        patch(orig.id, { undoneAt: null, canUndo: true, cannotUndo: undefined });
      await reload().catch(() => {});
    } else if (r.error === "changed_since") setRow(id, { changed: r.changed, blocked: r.blocked });
    else if (r.error === "expired") {
      setRow(id, {});
      patch(id, { canUndo: false, cannotUndo: "expired" });
    } else if (r.error === "already_undone") {
      setRow(id, {});
      patch(id, { canUndo: false, cannotUndo: "undone" });
      await reload().catch(() => {});
    } else setRow(id, { error: ERROR[r.error] });
  }

  async function showMore() {
    if (!next) return;
    setMore("busy");
    try {
      const page = await load({ before: next });
      setEntries((list) => [...list, ...page.entries.filter((e) => !list.some((x) => x.id === e.id))]);
      setNext(page.next);
      setMore("idle");
    } catch {
      setMore("failed");
    }
  }

  if (entries.length === 0) {
    return (
      <Card className="items-center py-12">
        <p className="text-body text-ink-3">No activity yet</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {byDay(entries, timeZone).map((day) => {
        const label = dayLabel(day.key, timeZone, today);
        return (
          <section key={day.key} aria-label={label} className="flex flex-col gap-2.5">
            <h2 className="text-label text-ink-3">{label}</h2>
            <Card className="gap-0 p-0 max-md:p-0">
              <ul>
                {day.entries.map((e) => (
                  <Row key={e.id} entry={e} timeZone={timeZone} state={rows[e.id] ?? {}} onUndo={(force) => runUndo(e.id, force)} onCancel={() => setRow(e.id, {})} />
                ))}
              </ul>
            </Card>
          </section>
        );
      })}
      {next && (
        <div className="flex items-center justify-center gap-3">
          <Button onClick={showMore} disabled={more === "busy"}>
            {more === "busy" ? "Loading…" : "Show more"}
          </Button>
          {more === "failed" && (
            <span role="status" className="text-label text-ink-3">
              Could not load. Try again.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const small = "h-7 px-2.5 text-label";

function Action({ entry, busy, onUndo }: { entry: ActivityEntry; busy?: boolean; onUndo: () => void }) {
  const verb = entry.undoOf ? "Redo" : "Undo";
  if (entry.undoneAt || entry.cannotUndo === "undone") return <Pill>Undone</Pill>;
  if (entry.canUndo)
    return (
      <Button className={small} disabled={busy} onClick={onUndo} aria-label={`${verb}: ${entry.summary}`}>
        {busy ? `${verb}ing…` : verb}
      </Button>
    );
  return (
    <span className="flex items-center gap-1.5">
      <Pill>{"Can't undo"}</Pill>
      {entry.cannotUndo && <InfoDot label="Why not">{WHY_NOT[entry.cannotUndo]}</InfoDot>}
    </span>
  );
}

function Row({
  entry,
  timeZone,
  state,
  onUndo,
  onCancel,
}: {
  entry: ActivityEntry;
  timeZone: string;
  state: RowState;
  onUndo: (force: boolean) => void;
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hasDetails = entry.details.length > 0;
  const summary = <span className="[overflow-wrap:anywhere]">{entry.summary}</span>;

  return (
    <li data-testid="activity-row" className="border-t border-rule px-6 py-3.5 first:border-t-0 max-md:px-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 md:grid-cols-[minmax(0,1fr)_64px_72px_minmax(84px,auto)]">
        <div className="min-w-0 text-body text-ink md:row-start-1">
          {hasDetails ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="group flex max-w-full items-start gap-1.5 rounded text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {summary}
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden className={cn("mt-[3px] flex-none text-ink-3 transition-transform duration-200 group-hover:text-ink motion-reduce:transition-none", open && "rotate-180")}>
                <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : (
            summary
          )}
        </div>
        <div className="flex gap-1.5 text-label text-ink-3 max-md:col-start-1 max-md:row-start-2 md:contents">
          <span className="md:col-start-2 md:row-start-1 md:text-body md:text-ink-2">{WHO[entry.actor]}</span>
          <span aria-hidden className="md:hidden">
            ·
          </span>
          <time dateTime={entry.at} className="tabular-nums md:col-start-3 md:row-start-1 md:text-body md:text-ink-2">
            {timeText(entry.at, timeZone)}
          </time>
        </div>
        <div className="col-start-2 row-span-2 row-start-1 flex justify-end md:col-start-4 md:row-span-1">
          <Action entry={entry} busy={state.busy} onUndo={() => onUndo(false)} />
        </div>
      </div>

      {open && hasDetails && (
        <ul className="mt-2.5 flex flex-col gap-1 rounded-lg bg-tint px-3.5 py-2.5 text-label text-ink-2">
          {entry.details.map((d, i) => (
            <li key={i} className="[overflow-wrap:anywhere]">
              {d}
            </li>
          ))}
        </ul>
      )}

      {state.changed && (
        <div role="alert" className="mt-2.5 flex flex-col gap-2 rounded-lg bg-tint px-3.5 py-3">
          <Label>{state.blocked ? "Can't undo" : "Changed since"}</Label>
          <ul className="flex flex-col gap-1 text-body text-ink">
            {state.changed.map((c, i) => (
              <li key={i} className="[overflow-wrap:anywhere]">
                {c}
              </li>
            ))}
          </ul>
          <div className="flex gap-2 pt-1">
            {!state.blocked && (
              <Button className={small} disabled={state.busy} onClick={() => onUndo(true)}>
                {entry.undoOf ? "Redo anyway" : "Undo anyway"}
              </Button>
            )}
            <Button variant="ghost" className={small} onClick={onCancel}>
              {state.blocked ? "OK" : "Cancel"}
            </Button>
          </div>
        </div>
      )}

      {state.error && (
        <p role="status" className="mt-1.5 text-label text-ink">
          {state.error}
        </p>
      )}
    </li>
  );
}
