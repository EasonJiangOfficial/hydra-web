"use client";

import { useMemo, useSyncExternalStore } from "react";
import { DashboardGrid, defineRegistry } from "@/components/grid";
import { localPersistence, parseLocal, readLocalRaw } from "@/components/grid/local-persistence";
import { Label, Seg } from "@/components/kit";
import { DASHBOARD_BLOCKS } from "@/lib/layout/blocks";
import { scopes, scopesShort } from "../kit/fixtures";
import {
  AccountsCard,
  ComingUpCard,
  GoalsCard,
  MonthCard,
  NetWorthCard,
  PostingCard,
  RecentCard,
  SummaryCard,
  UgcCard,
} from "./demo-blocks";

const registry = defineRegistry(DASHBOARD_BLOCKS, {
  "net-worth": NetWorthCard,
  summary: SummaryCard,
  accounts: AccountsCard,
  month: MonthCard,
  ugc: UgcCard,
  posting: PostingCard,
  recent: RecentCard,
  goals: GoalsCard,
  "coming-up": ComingUpCard,
});

const never = () => () => {};

/** The grid with kit cards, saved to localStorage (no session here; the action path is unit-tested). */
export function GridDemo() {
  // undefined on the server and while hydrating: the grid starts once the saved layout is read.
  const raw = useSyncExternalStore<string | null | undefined>(never, readLocalRaw, () => undefined);
  const initial = useMemo(() => (raw === undefined ? undefined : parseLocal(raw)), [raw]);
  if (!initial) return null;
  return (
    <DashboardGrid
      registry={registry}
      initial={initial}
      persistence={localPersistence}
      lead={<Label className="max-md:hidden">Saturday, November 21</Label>}
      trail={
        <>
          <Seg aria-label="Scope" items={scopes} defaultValue="all" className="max-md:hidden" />
          <Seg aria-label="Scope" items={scopesShort} defaultValue="all" size="touch" className="md:hidden" />
        </>
      }
    />
  );
}
