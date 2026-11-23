"use client";

import { RoutinesWorkspace } from "@/components/routines/workspace";

import { fixtureData } from "./fixture-data";
import { useMemoryRoutines } from "./memory-actions";

/** The Routines workspace on in-memory data. */
export function RoutinesFixture() {
  const { data, actions } = useMemoryRoutines(fixtureData());
  return <RoutinesWorkspace data={data} actions={actions} />;
}
