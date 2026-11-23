"use client";

import { useState, useSyncExternalStore } from "react";

import { UndoHost } from "@/components/activity/undo-bar";
import { fixtureRaw } from "@/components/ugc/fixture-data";
import { createMemory } from "@/components/ugc/memory-actions";
import { UgcProvider } from "@/components/ugc/store";
import { UgcWorkspace } from "@/components/ugc/workspace";

/** The UGC Tracker on in-memory rows. Writes work and show; a reload starts over. The clock is fixed at Nov 21, 2026. */
export function UgcFixture() {
  const [memory] = useState(() => createMemory(fixtureRaw()));
  const raw = useSyncExternalStore(memory.subscribe, memory.get, memory.get);
  return (
    <UgcProvider raw={raw} actions={memory.actions} basePath="/dev/ugc">
      <UgcWorkspace />
      {/* Link and unlink return an in-memory activity id; this bar undoes it in memory. */}
      <UndoHost undo={memory.undo} />
    </UgcProvider>
  );
}
