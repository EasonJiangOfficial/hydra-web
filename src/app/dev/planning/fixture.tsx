"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { PlanningProvider } from "@/components/planning/planning-store";
import { PlanningWorkspace } from "@/components/planning/planning-workspace";
import { fixtureSnapshot } from "@/lib/planning/fixtures";
import { createMemoryActions } from "@/lib/planning/memory-actions";

/** A fixed clock: the fixture's dates (and the e2e) never drift. Saturday, November 21, 2026, Toronto. */
const NOW = "2026-11-21T15:00:00.000Z";

/**
 * The Planning workspace on in-memory data. Writes work and show; a reload starts over.
 * `?fail=move`: card moves fail after 300 ms, so the e2e sees the rollback and its message.
 */
export function PlanningFixture() {
  const failMoves = useSearchParams().get("fail") === "move";
  const [memory] = useState(() => {
    const m = createMemoryActions(fixtureSnapshot(new Date(NOW)), { now: () => new Date(NOW) });
    if (!failMoves) return m;
    const setTaskPositions: typeof m.actions.setTaskPositions = () =>
      new Promise((done) => setTimeout(() => done({ ok: false, error: "Could not move it. Try again." }), 300));
    return { ...m, actions: { ...m.actions, setTaskPositions } };
  });
  return (
    <PlanningProvider initial={memory.snapshot()} actions={memory.actions} now={NOW}>
      <PlanningWorkspace />
    </PlanningProvider>
  );
}
