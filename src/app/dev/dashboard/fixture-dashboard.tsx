"use client";

import { useMemo, useSyncExternalStore } from "react";
import { Dashboard } from "@/components/dashboard/dashboard";
import type { DashboardData } from "@/components/dashboard/types";
import { localPersistence, parseLocal, readLocalRaw } from "@/components/grid/local-persistence";

const never = () => () => {};

/** The Dashboard with layouts saved to localStorage (no session here; the action path is unit-tested in U17). */
export function FixtureDashboard({ data }: { data: DashboardData }) {
  // undefined on the server and while hydrating: the grid starts once the saved layout is read.
  const raw = useSyncExternalStore<string | null | undefined>(never, readLocalRaw, () => undefined);
  const initial = useMemo(() => (raw === undefined ? undefined : parseLocal(raw)), [raw]);
  if (!initial) return null;
  return <Dashboard data={data} initial={initial} persistence={localPersistence} />;
}
