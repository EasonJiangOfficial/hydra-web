"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { PlanningPage } from "@/app/(app)/planning/_components/planning-page";
import { addDays } from "@/lib/planning/dates";
import { fixtureSnapshot } from "@/lib/planning/fixtures";
import { createMemoryActions } from "@/lib/planning/memory-actions";
import { createMetricRegistry } from "@/lib/planning/metrics";
import type { FinanceFacts } from "@/lib/planning-metrics/finance-dates";
import { createResolvers } from "@/lib/planning-metrics/resolvers";
import type { MetricSource } from "@/lib/planning-metrics/source";

/** A fixed clock: the fixture's dates (and the e2e) never drift. Saturday, November 21, 2026, Toronto. */
const NOW = "2026-11-21T15:00:00.000Z";

/** Card due dates and a deal's pay cycle, as the money data would give them. */
const FACTS: FinanceFacts = {
  cards: [{ id: "card-sapphire", name: "Sapphire 4242", dueOn: "2026-11-25", balanceCents: 84_212 }],
  deals: [
    {
      id: "deal-wordwise",
      brand: "Wordwise",
      status: "active",
      startDate: "2026-09-01",
      endDate: null,
      payCycle: "MONTHLY",
      anchorDay: 28,
      anchorWeekday: null,
      anchorDays: [],
      owedCents: 120_000,
    },
  ],
};

/** Figures the real resolvers run over: the same code as the live page, a fake ledger underneath. */
const SOURCE: MetricSource = {
  netWorthCents: async () => 4_821_200,
  incomeCents: async () => 640_000,
  spending: async () => ({ totalCents: 440_000, rows: [{ categoryId: "food", name: "Food", cents: 42_000 }] }),
  ugcEarnedCents: async () => 315_000,
  postingDays: async (r) => {
    const days = [];
    for (let d = r.from, i = 0; d <= r.to; d = addDays(d, 1), i += 1) days.push({ date: d, posted: i % 3 === 0 ? 2 : 3, target: 3 });
    return days;
  },
  views: async () => ({ posts: 19, views: 182_000 }),
};

let registry = createMetricRegistry();
for (const [key, resolver] of Object.entries(createResolvers(SOURCE))) registry = registry.register(key as never, resolver);

/** `?deleted=1`: two items whose Google Calendar events were deleted (Send W-9, Weekly review). */
const GOOGLE_DELETES = [
  { linkId: "00000000-0000-4000-8000-000000000901", kind: "task" as const, itemId: "00000000-0000-4000-8000-000000000101", title: "Send W-9 to Brightleaf" },
  { linkId: "00000000-0000-4000-8000-000000000902", kind: "event" as const, itemId: "00000000-0000-4000-8000-000000000400", title: "Weekly review" },
];

/** The Planning page on in-memory data. Writes work and show; a reload starts over. */
export function PlanningPageFixture() {
  const [memory] = useState(() => createMemoryActions(fixtureSnapshot(new Date(NOW)), { now: () => new Date(NOW) }));
  const deleted = useSearchParams().get("deleted") === "1";
  return (
    <PlanningPage
      initial={memory.snapshot()}
      actions={memory.actions}
      facts={FACTS}
      registry={registry}
      now={NOW}
      googleDeletes={deleted ? { initial: GOOGLE_DELETES, keep: async () => true } : undefined}
    />
  );
}
