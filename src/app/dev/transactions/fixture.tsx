"use client";

import { useState } from "react";

import { matchesFilters } from "@/components/transactions/describe";
import { FIXTURE_TODAY } from "@/components/transactions/fixture-data";
import { createMemoryApi } from "@/components/transactions/memory-api";
import { TransactionsWorkspace } from "@/components/transactions/workspace";

/** The Transactions workspace on a few thousand rows in memory. Writes work and show; a reload starts over. */
export function TransactionsFixture() {
  const [memory] = useState(() => createMemoryApi({ delayMs: 40 }));
  const review = memory.rows().filter((r) => matchesFilters(r, { review: true })).length;
  return <TransactionsWorkspace api={memory.api} lookups={memory.lookups} rules={memory.rules} reviewCount={review} today={FIXTURE_TODAY} />;
}
