"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { Card, Label, Pill, cn, drawerHref, type DrawerParam } from "@/components/kit";
import { Switch, useSynced } from "@/components/accounts/switch";

import { STATUS_LABEL, whenText } from "./format";
import { useRoutines } from "./store";
import type { RoutineView, RunStatus } from "./types";

/** The `?routine=` panel. The kit's DrawerParam union has no "routine" yet; the drawer treats the param as any string. */
export const ROUTINE_PARAM: DrawerParam = "routine";

/** Red is for money lost or overdue only: a failed run is bold ink. */
export const statusTone = (s: RunStatus) => (s === "failed" ? "strong" : s === "ok" ? "soft" : "default");

/** The last run's result as plain status text. */
export function RunStatusPill({ status }: { status: RunStatus }) {
  return <Pill tone={statusTone(status)}>{STATUS_LABEL[status]}</Pill>;
}

function Cell({ label, className, children }: { label: string; className: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 md:row-start-1", className)}>
      <Label className="text-tag md:sr-only">{label}</Label>
      {children}
    </div>
  );
}

function Row({ routine }: { routine: RoutineView }) {
  const { data, actions, attempt } = useRoutines();
  const pathname = usePathname();
  const search = useSearchParams();
  const [on, setOn] = useSynced(!routine.paused);
  const last = routine.runs[0];

  return (
    <li
      data-testid="routine-row"
      className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-3 border-t border-rule px-6 py-4 transition-colors duration-200 first:border-t-0 hover:bg-hover max-md:px-4 md:grid-cols-[minmax(0,1.5fr)_minmax(0,0.9fr)_minmax(0,1.3fr)_auto]"
    >
      <div className="min-w-0 md:col-start-1 md:row-start-1">
        <Link
          href={drawerHref(pathname, search, ROUTINE_PARAM, routine.id)}
          scroll={false}
          className="block truncate rounded text-body font-medium text-ink outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ink"
        >
          {routine.name}
        </Link>
        <p className="truncate text-label text-ink-3">{routine.scheduleText}</p>
      </div>
      <div className="relative z-10 flex items-center max-md:col-start-2 max-md:row-start-1 md:col-start-4 md:row-start-1">
        <Switch
          label={`${routine.name} is on`}
          checked={on}
          onChange={async (next) => {
            setOn(next);
            if (!(await attempt(actions.setPaused(routine.id, !next)))) setOn(!next);
          }}
        />
      </div>
      <div className="col-span-2 grid grid-cols-2 gap-x-6 md:contents">
        <Cell label="Next run" className="md:col-start-2">
          <span className="truncate text-body tabular-nums">{routine.paused || !routine.nextRunAt ? "Paused" : whenText(routine.nextRunAt, data.timeZone, data.now)}</span>
        </Cell>
        <Cell label="Last run" className="md:col-start-3">
          {last ? (
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-body">
              <span className="tabular-nums">{whenText(last.occurrenceAt, data.timeZone, data.now)}</span>
              <RunStatusPill status={last.status} />
            </span>
          ) : (
            <span className="text-body text-ink-3">Not yet</span>
          )}
        </Cell>
      </div>
    </li>
  );
}

/** The routines, one row each: name, schedule in words, next run, last run with its result, and the on/off switch. */
export function RoutineList({ className }: { className?: string }) {
  const { data } = useRoutines();
  return (
    <Card as="section" aria-label="Routines" className={cn("gap-0 p-0 max-md:p-0", className)}>
      <div aria-hidden className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,0.9fr)_minmax(0,1.3fr)_auto] gap-x-6 border-b border-rule px-6 py-3 text-label text-ink-3 max-md:hidden">
        <span>Routine</span>
        <span>Next run</span>
        <span>Last run</span>
        <span className="w-9" />
      </div>
      <ul>
        {data.routines.map((r) => (
          <Row key={r.id} routine={r} />
        ))}
      </ul>
    </Card>
  );
}
