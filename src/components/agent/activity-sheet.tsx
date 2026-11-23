"use client";

import { ChevronDown, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useEffect, useRef, useState, type Ref } from "react";
import { EASE } from "@/components/kit/seg";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { groupActivity, whenWhere, type ActivityRun } from "./activity";
import { useAgent } from "./context";
import type { Activity } from "./types";

const heading = "text-label font-normal text-ink-3";
/** The panel's Close look (34 px, ink-3, tint on hover). */
export const PANEL_ICON =
  "relative inline-grid size-[34px] flex-none place-items-center rounded-lg text-ink-3 outline-none transition-colors duration-200 ease-hydra hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-ink";

/**
 * The agent panel's activity, as a slide-over inside the panel (owner: "the activity list is blocking the side chat,
 * redesign this"). It covers everything under the header and enters 28 px from the right with a fade (a fade alone
 * under reduced motion). Newest first, in "This chat" and "Earlier"; repeats of one label fold into a row with a count.
 * Undo shows on row hover or focus with a mouse, always on touch. When and where a change ran shows on hover.
 */
export function ActivitySheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { ctl, state } = useAgent();
  const still = useReducedMotion();
  const self = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const { here, earlier } = groupActivity(state.activity, state.threadId);
  const from = still ? { opacity: 0 } : { x: 28, opacity: 0 };

  // Focus moves in on open (the panel's button gets it back on close).
  useEffect(() => self.current?.focus(), []);

  const undo = async (row: Activity) => {
    if (!row.undoId) return;
    setBusy((b) => ({ ...b, [row.id]: true }));
    setFailed((f) => ({ ...f, [row.id]: false }));
    const ok = await ctl.undo(row.undoId);
    setBusy((b) => ({ ...b, [row.id]: false }));
    if (!ok) setFailed((f) => ({ ...f, [row.id]: true }));
  };
  const rowProps = { busy, failed, onUndo: (r: Activity) => void undo(r) };

  return (
    <motion.section
      ref={self as Ref<HTMLElement>}
      id={id}
      tabIndex={-1}
      aria-label="Activity"
      data-testid="agent-activity"
      className="absolute inset-0 z-10 flex flex-col gap-3 bg-surface outline-none"
      initial={from}
      animate={{ x: 0, opacity: 1 }}
      exit={from}
      transition={{ duration: 0.2, ease: EASE }}
    >
      <div className="flex items-center gap-3">
        <h2 className="flex-1 text-body text-ink">Activity</h2>
        <button type="button" aria-label="Close activity" onClick={onClose} className={cn(PANEL_ICON, "-mr-2")}>
          <X aria-hidden className="size-4" strokeWidth={1.5} />
        </button>
      </div>
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-1">
        {!here.length && !earlier.length && <p className="text-body text-ink-3">No changes yet.</p>}
        <Group title="This chat" runs={here} {...rowProps} />
        <Group title="Earlier" runs={earlier} {...rowProps} />
      </div>
      <div className="border-t border-rule pt-3">
        <Link href="/activity" className="relative text-label text-ink-3 underline-offset-4 transition-colors duration-200 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-ink pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-2 pointer-coarse:after:content-['']">
          All activity
        </Link>
      </div>
    </motion.section>
  );
}

type RowProps = { busy: Record<string, boolean>; failed: Record<string, boolean>; onUndo: (row: Activity) => void };

function Group({ title, runs, ...rowProps }: { title: string; runs: ActivityRun[] } & RowProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!runs.length) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className={heading}>{title}</h3>
      <ul className="flex flex-col">
        {runs.map((run) =>
          run.rows.length === 1 ? (
            <Row key={run.key} row={run.rows[0]} {...rowProps} />
          ) : (
            <li key={run.key} className="flex flex-col border-t border-rule first:border-t-0">
              <button
                type="button"
                aria-expanded={!!open[run.key]}
                onClick={() => setOpen((o) => ({ ...o, [run.key]: !o[run.key] }))}
                title={whenWhere(run.rows[0])}
                className="group/run flex min-h-9 w-full items-center gap-2 text-left outline-none focus-visible:outline-2 focus-visible:outline-ink"
              >
                <span className={cn("min-w-0 truncate text-body", run.rows.every((r) => r.undone) ? "text-ink-3 line-through" : "text-ink")}>{run.label}</span>
                <span className="flex-none text-tag text-ink-3 tabular-nums">×{run.rows.length}</span>
                <span className="flex-1" />
                <ChevronDown
                  aria-hidden
                  strokeWidth={1.5}
                  className={cn("size-3.5 flex-none text-ink-3 transition-transform duration-200 ease-hydra group-hover/run:text-ink", open[run.key] && "rotate-180")}
                />
              </button>
              {open[run.key] && (
                <ul className="flex flex-col pl-3">
                  {run.rows.map((row) => (
                    <Row key={row.id} row={row} {...rowProps} />
                  ))}
                </ul>
              )}
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

function Row({ row, busy, failed, onUndo }: { row: Activity } & RowProps) {
  const bad = !!failed[row.id];
  return (
    <li data-activity-row="" className="group flex min-h-9 items-center gap-3 border-t border-rule first:border-t-0">
      <span title={whenWhere(row)} className={cn("min-w-0 flex-1 truncate text-body", row.undone ? "text-ink-3 line-through" : "text-ink")}>
        {row.label}
      </span>
      {bad && <span className="flex-none text-tag text-ink-2">Not undone</span>}
      {row.undone ? (
        <span className="flex-none text-tag text-ink-3">Undone</span>
      ) : (
        row.undoId && (
          <Button
            variant="outline"
            size="icon-sm"
            disabled={busy[row.id]}
            onClick={() => onUndo(row)}
            aria-label={`Undo: ${row.label}`}
            className={cn(
              // On touch the hit area is the row's full 36 px height.
              "relative w-auto px-2.5 text-tag transition-[opacity,background-color,transform] pointer-coarse:after:absolute pointer-coarse:after:-inset-1 pointer-coarse:after:content-['']",
              // Shown on hover or focus with a mouse; always while it runs, after a failure, and on touch.
              !bad && !busy[row.id] && "pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100",
            )}
          >
            Undo
          </Button>
        )
      )}
    </li>
  );
}
