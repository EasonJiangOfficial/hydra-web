"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button, DetailDrawer, setDrawerUrl, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/kit";

import { whenText } from "./format";
import { Notice } from "./notice";
import { ROUTINE_PARAM, RunStatusPill } from "./routine-list";
import { RoutineForm } from "./routine-form";
import { useRoutines } from "./store";
import type { RoutineView, RunView } from "./types";

/**
 * The shared slide-out for `?routine=`: runs with their output and actions, the settings, and Run now, Pause, Delete.
 */
export function RoutinePanel() {
  return (
    <DetailDrawer param={ROUTINE_PARAM} label="Routine">
      {(id) => <PanelBody id={id} />}
    </DetailDrawer>
  );
}

function RunItem({ run }: { run: RunView }) {
  const { data, actions, attempt } = useRoutines();
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <li data-testid="run" className="flex flex-col gap-2 border-t border-rule py-3.5 first:border-t-0">
      <div className="flex items-baseline gap-3">
        <span className="text-body font-medium tabular-nums">{whenText(run.occurrenceAt, data.timeZone, data.now)}</span>
        <RunStatusPill status={run.status} />
      </div>
      {run.output && <p className="text-body whitespace-pre-wrap text-ink-2">{run.output}</p>}
      {run.error && <p className="text-label text-ink-2">{run.error}</p>}
      {run.actions.length > 0 && (
        <ul aria-label="Actions taken" className="flex flex-col rounded-lg bg-tint px-3">
          {run.actions.map((a) => (
            <li key={a.id} className="flex items-center gap-3 border-t border-rule py-1.5 text-label first:border-t-0">
              <span className="min-w-0 flex-1">{a.summary}</span>
              {a.undone ? (
                <span className="text-tag text-ink-3">Undone</span>
              ) : a.undoable ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="w-auto px-2 text-label"
                  disabled={busy === a.id}
                  aria-label={`Undo: ${a.summary}`}
                  onClick={async () => {
                    setBusy(a.id);
                    await attempt(actions.undo(a.id), "Undone.");
                    setBusy(null);
                  }}
                >
                  Undo
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Controls({ routine, close }: { routine: RoutineView; close: () => void }) {
  const { actions, attempt } = useRoutines();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  if (asking) {
    return (
      <div role="alertdialog" aria-label="Delete this routine?" className="flex flex-col gap-3 rounded-lg bg-tint p-3.5">
        <p className="text-body">Delete this routine and its run history?</p>
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const done = await attempt(actions.remove(routine.id), `Deleted ${routine.name}.`);
              setBusy(false);
              if (done) close();
            }}
          >
            Delete
          </Button>
          <Button variant="ghost" onClick={() => setAsking(false)}>
            Keep it
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button disabled={routine.paused || busy} onClick={() => void attempt(actions.runNow(routine.id), "Running within a minute.")}>
        Run now
      </Button>
      <Button disabled={busy} onClick={() => void attempt(actions.setPaused(routine.id, !routine.paused), routine.paused ? "Resumed." : "Paused.")}>
        {routine.paused ? "Resume" : "Pause"}
      </Button>
      <Button variant="ghost" onClick={() => setAsking(true)}>
        Delete
      </Button>
    </div>
  );
}

function PanelBody({ id }: { id: string }) {
  const { data, actions } = useRoutines();
  const pathname = usePathname();
  const search = useSearchParams();
  const [tab, setTab] = useState<"runs" | "settings">("runs");
  const routine = data.routines.find((r) => r.id === id);
  if (!routine) return <p className="text-body text-ink-3">That routine is gone.</p>;

  function close() {
    const next = new URLSearchParams(search.toString());
    next.delete(ROUTINE_PARAM);
    const qs = next.toString();
    setDrawerUrl(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="flex flex-col gap-5" data-testid="routine-panel">
      <div className="flex flex-col gap-1">
        <h2 className="text-section">{routine.name}</h2>
        <p className="text-label text-ink-3">
          {routine.scheduleText} · {routine.paused || !routine.nextRunAt ? "Paused" : `Next ${whenText(routine.nextRunAt, data.timeZone, data.now)}`}
        </p>
      </div>
      <Controls routine={routine} close={close} />
      <Notice />
      <Tabs value={tab} onValueChange={(v) => setTab(v as "runs" | "settings")}>
        <TabsList aria-label="Routine sections">
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="runs">
          {routine.runs.length ? (
            <ul aria-label="Run history">
              {routine.runs.map((run) => (
                <RunItem key={run.id} run={run} />
              ))}
            </ul>
          ) : (
            <p className="text-body text-ink-3">No runs yet.</p>
          )}
        </TabsContent>
        <TabsContent value="settings">
          <RoutineForm
            key={routine.id}
            initial={{ name: routine.name, instruction: routine.instruction, schedule: routine.schedule, tools: routine.tools, delivery: routine.delivery, whenMacOff: routine.whenMacOff }}
            submitLabel="Save changes"
            onSubmit={(input) => actions.update(routine.id, input)}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
