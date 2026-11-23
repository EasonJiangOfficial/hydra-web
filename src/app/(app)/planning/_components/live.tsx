"use client";

import { useMemo } from "react";

import * as server from "@/lib/planning/actions";
import type { PlanningActions, PlanningSnapshot } from "@/lib/planning/types";
import type { FinanceFacts } from "@/lib/planning-metrics/finance-dates";
import { createRemoteRegistry } from "@/lib/planning-metrics/remote";

import { keepGoogleItem, resolveMetric } from "../actions";
import type { GoogleDelete } from "./google-deletes";
import { PlanningPage } from "./planning-page";

/** The page's writes are the server actions, as the signed-in owner. */
const liveActions: PlanningActions = { ...server };

/** Planning on the real database: server actions, and goal bars that read live money and UGC figures. */
export function LivePlanning({
  initial,
  facts,
  seed,
  googleDeletes,
}: {
  initial: PlanningSnapshot;
  facts: FinanceFacts;
  /** Items deleted in Google Calendar, waiting for Delete or Keep. */
  googleDeletes: readonly GoogleDelete[];
  /** Readings the server already made, so the bars are right on first paint. */
  seed: Readonly<Record<string, number | null>>;
}) {
  const registry = useMemo(() => createRemoteRegistry(resolveMetric, seed), [seed]);
  return (
    <PlanningPage
      initial={initial}
      actions={liveActions}
      facts={facts}
      registry={registry}
      googleDeletes={{ initial: googleDeletes, keep: keepGoogleItem }}
    />
  );
}
