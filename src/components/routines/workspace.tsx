"use client";

import { Plus } from "lucide-react";
import { useSearchParams } from "next/navigation";

import { Button, Card } from "@/components/kit";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

import { ApprovalsStrip } from "./approvals-strip";
import { Notice } from "./notice";
import { RoutineForm } from "./routine-form";
import { ROUTINE_PARAM, RoutineList } from "./routine-list";
import { RoutinePanel } from "./routine-panel";
import { RoutinesProvider, useRoutines } from "./store";
import type { RoutinesActions, RoutinesData } from "./types";

function NewRoutine() {
  const { actions, creating, setCreating, say } = useRoutines();
  return (
    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent aria-describedby={undefined} className="max-h-[88dvh] gap-5 overflow-y-auto p-6 text-body sm:max-w-lg" data-testid="new-routine">
        <DialogTitle className="pr-8 text-section">New routine</DialogTitle>
        <DialogDescription className="sr-only">Make a routine Hydra runs on a schedule</DialogDescription>
        <RoutineForm
          submitLabel="Add routine"
          onSubmit={async (input) => {
            const r = await actions.create(input);
            if (r.ok) {
              setCreating(false);
              say(`Added ${input.name}.`);
            }
            return r;
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function Body() {
  const { data, setCreating } = useRoutines();
  // The panel carries its own status line, so the page's stays quiet while the panel covers it.
  const panelOpen = useSearchParams().has(ROUTINE_PARAM);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <div className="flex-1" />
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus aria-hidden strokeWidth={1.5} />
          New routine
        </Button>
      </div>
      {!panelOpen && <Notice />}
      <ApprovalsStrip />
      {data.routines.length ? (
        <RoutineList />
      ) : (
        <Card as="section" aria-label="Routines">
          <p className="text-body text-ink-3">No routines yet.</p>
        </Card>
      )}
      <RoutinePanel />
      <NewRoutine />
    </div>
  );
}

/**
 * The Routines page body: the "Waiting for you" strip, the list, the routine panel (`?routine=`) and the
 * New routine dialog. It holds no data of its own: the live page passes server data and the agent's routine
 * actions, /dev/routines passes memory ones. Render it inside a Suspense boundary (it reads the search params).
 */
export function RoutinesWorkspace({ data, actions }: { data: RoutinesData; actions: RoutinesActions }) {
  return (
    <RoutinesProvider data={data} actions={actions}>
      <Body />
    </RoutinesProvider>
  );
}
