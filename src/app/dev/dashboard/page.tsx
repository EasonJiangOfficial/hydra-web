import type { Metadata } from "next";
import { Suspense } from "react";
import { scopeFrom } from "@/components/dashboard/derive";
import { AppShell } from "@/components/shell/app-shell";
import { DashboardLoading } from "@/components/shell/skeletons";
import { fixtureData, fixtureEmpty, withViewGaps } from "@/components/dashboard/fixture";
import { DevScopeEntities } from "../settings/dev-entities";
import { FixtureDashboard } from "./fixture-dashboard";

/** Explicit props, not the generated PageProps: the pre-push hook runs plain tsc, which sees stale route types. */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: "Dashboard fixture" };

/**
 * Fixture for the Dashboard (U6): the real cards on fixture data, inside the app shell, layouts kept
 * in localStorage. `?state=empty` (no accounts), `?state=loading` (the route skeleton) and `?state=views`
 * (the missed-day view warning) show the other states; `?scope=` filters like the live page. `?added=on` lists
 * Studio Co (money, no accounts of its own) in the switch; `?scope=ugm` is a business with nothing in it.
 */
export default function DashboardFixturePage(props: { searchParams: SearchParams }) {
  return (
    <DevScopeEntities>
      <AppShell activeHref="/">
        <div className="flex flex-col gap-5">
          <Suspense fallback={<DashboardLoading />}>
            <Board searchParams={props.searchParams} />
          </Suspense>
        </div>
      </AppShell>
    </DevScopeEntities>
  );
}

async function Board({ searchParams }: { searchParams: SearchParams }) {
  const q = await searchParams;
  if (q.state === "loading") return <DashboardLoading />;
  const scope = scopeFrom(typeof q.scope === "string" ? q.scope : null);
  const data = q.state === "empty" ? fixtureEmpty() : q.state === "views" ? withViewGaps(fixtureData(scope)) : fixtureData(scope);
  return <FixtureDashboard data={data} />;
}
