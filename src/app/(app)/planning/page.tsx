import { connection } from "next/server";
import { Suspense } from "react";

import { PageHeader } from "@/components/shell/page-header";
import { listPendingDeletes } from "@/lib/google/calendar";
import { loadPlanning } from "@/lib/planning/actions";
import { NO_FINANCE } from "@/lib/planning-metrics/finance-dates";
import { ownerCtx } from "@/lib/planning/server";

import { LivePlanning } from "./_components/live";
import { loadFinanceFacts, seedMetrics } from "./load";

export const metadata = { title: "Planning" };

/**
 * Planning: goals with live bars, then the Board, Calendar or Table, and the panels.
 * The reads run side by side (one round trip deep, then the goal metrics), not one after another.
 */
export default async function PlanningPage() {
  await connection(); // the owner's data: request time only, before any read starts
  const ctx = ownerCtx().catch(() => null); // a refused owner is reported by loadPlanning below
  const [result, owner, facts, pending] = await Promise.all([
    loadPlanning(),
    ctx,
    ctx.then((c) => (c ? loadFinanceFacts(c.db, c.now()) : NO_FINANCE)),
    listPendingDeletes(),
  ]);
  if (!result.ok || !owner) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Planning" />
        <p role="alert" className="text-label text-ink-3">
          {result.ok ? "Not allowed." : result.error}
        </p>
      </div>
    );
  }
  const seed = await seedMetrics(owner.db, result.value, owner.now());
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Planning" />
      <Suspense fallback={null}>
        <LivePlanning initial={result.value} facts={facts} seed={seed} googleDeletes={pending.ok ? pending.data : []} />
      </Suspense>
    </div>
  );
}
